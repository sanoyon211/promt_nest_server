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

module.exports = router;
