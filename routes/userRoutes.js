const express = require('express');
const { getDB } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');

const router = express.Router();

// Save user details
router.post('/users', async (req, res) => {
  try {
    const user = req.body;
    
    const db = getDB();
    const existingUser = await db.collection('users').findOne({ email: user.email });
    
    if (existingUser) {
      if (user.name && user.name !== 'Unknown User') {
        await db.collection('users').updateOne(
          { email: user.email },
          { $set: { name: user.name, photoURL: user.photoURL } }
        );
      }
      return res.send({ message: 'User already exists', insertedId: null });
    }
    
    user.role = user.role || 'User';
    user.subscription = user.subscription || 'Free';
    user.createdAt = new Date();
    const result = await db.collection('users').insertOne(user);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error saving user', error });
  }
});

// Fetch user details by email
router.get('/users/:email', verifyToken, async (req, res) => {
  try {
    const email = req.params.email;
    if (email !== req.decoded.email) {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    
    const db = getDB();
    const user = await db.collection('users').findOne({ email });
    if (user) {
      user.totalPrompts = await db.collection('prompts').countDocuments({ creatorEmail: email });
    }
    res.send(user);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching user', error });
  }
});

// Fetch current user's reviews
router.get('/user/reviews', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const reviews = await db.collection('reviews').find({ email }).sort({ date: -1 }).toArray();
    res.send(reviews);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching reviews', error });
  }
});

// Fetch current user's bookmarks
router.get('/user/bookmarks', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const bookmarks = await db.collection('bookmarks').aggregate([
      { $match: { email } },
      { $addFields: { promptObjId: { $toObjectId: "$promptId" } } },
      {
        $lookup: {
          from: "prompts",
          localField: "promptObjId",
          foreignField: "_id",
          as: "prompt"
        }
      },
      { $unwind: "$prompt" },
      {
        $lookup: {
          from: "users",
          localField: "prompt.creatorEmail",
          foreignField: "email",
          as: "prompt.creator"
        }
      },
      { $unwind: { path: "$prompt.creator", preserveNullAndEmptyArrays: true } },
      { $sort: { createdAt: -1 } }
    ]).toArray();
    res.send(bookmarks);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching bookmarks', error });
  }
});

// Fetch current user's copied prompts
router.get('/user/copied', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const copied = await db.collection('copied_prompts').aggregate([
      { $match: { email } },
      { $addFields: { promptObjId: { $toObjectId: "$promptId" } } },
      {
        $lookup: {
          from: "prompts",
          localField: "promptObjId",
          foreignField: "_id",
          as: "prompt"
        }
      },
      { $unwind: "$prompt" },
      {
        $lookup: {
          from: "users",
          localField: "prompt.creatorEmail",
          foreignField: "email",
          as: "prompt.creator"
        }
      },
      { $unwind: { path: "$prompt.creator", preserveNullAndEmptyArrays: true } },
      { $sort: { copiedAt: -1 } }
    ]).toArray();
    res.send(copied);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching copied prompts', error });
  }
});

// Regular User Analytics Dashboard
router.get('/user/analytics', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();

    // Count user's total prompts
    const totalPrompts = await db.collection('prompts').countDocuments({ creatorEmail: email });

    // Count user's total bookmarks
    const totalBookmarks = await db.collection('bookmarks').countDocuments({ email: email });

    res.send({
      totalPrompts,
      totalBookmarks
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching user analytics', error });
  }
});

// Creator Analytics Dashboard
router.get('/creator/analytics', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();

    // 1. Total Prompts authored by this creator
    const totalPrompts = await db.collection('prompts').countDocuments({ creatorEmail: email });

    // 2. Fetch all prompt IDs authored by this creator
    const creatorPrompts = await db.collection('prompts').find({ creatorEmail: email }, { projection: { _id: 1, copyCount: 1 } }).toArray();
    const promptIds = creatorPrompts.map(p => p._id.toString());

    // 3. Total Copies
    const totalCopies = creatorPrompts.reduce((sum, p) => sum + (p.copyCount || 0), 0);

    // 4. Total Bookmarks (how many times this creator's prompts were bookmarked)
    const totalBookmarks = await db.collection('bookmarks').countDocuments({ promptId: { $in: promptIds } });

    // 5. Chart Data (Prompt Growth over 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const chartDataMap = {};
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      chartDataMap[key] = { name: monthNames[d.getMonth()], prompts: 0, order: i };
    }

    const promptsByMonth = await db.collection('prompts').aggregate([
      { $match: { creatorEmail: email, createdAt: { $gte: sixMonthsAgo } } },
      { $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    promptsByMonth.forEach(item => {
      if (item._id.month) {
        const key = `${item._id.year}-${item._id.month - 1}`;
        if (chartDataMap[key]) {
          chartDataMap[key].prompts = item.count;
        }
      }
    });

    const chartData = Object.values(chartDataMap).sort((a, b) => a.order - b.order).map(({ name, prompts }) => ({ name, prompts }));

    // 6. Daily Copies (Last 7 Days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dailyCopiesMap = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      dailyCopiesMap[key] = { day: dayNames[d.getDay()], copies: 0, order: i };
    }

    const copiesByDay = await db.collection('copied_prompts').aggregate([
      { $match: { promptId: { $in: promptIds }, copiedAt: { $gte: sevenDaysAgo } } },
      { $group: {
          _id: { year: { $year: "$copiedAt" }, month: { $month: "$copiedAt" }, day: { $dayOfMonth: "$copiedAt" } },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    copiesByDay.forEach(item => {
      if (item._id.month) {
        const key = `${item._id.year}-${item._id.month - 1}-${item._id.day}`;
        if (dailyCopiesMap[key]) {
          dailyCopiesMap[key].copies = item.count;
        }
      }
    });

    const dailyCopiesData = Object.values(dailyCopiesMap).sort((a, b) => a.order - b.order).map(({ day, copies }) => ({ day, copies }));

    res.send({
      totalPrompts,
      totalBookmarks,
      totalCopies,
      chartData,
      dailyCopiesData
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching creator analytics', error });
  }
});

module.exports = router;
