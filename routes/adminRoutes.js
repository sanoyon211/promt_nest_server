const express = require('express');
const { ObjectId } = require('mongodb');
const { getDB } = require('../db');
const { verifyToken, verifyAdmin } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const reports = await db.collection('reported_prompts').aggregate([
      { $addFields: { promptObjId: { $toObjectId: "$promptId" } } },
      {
        $lookup: {
          from: "prompts",
          localField: "promptObjId",
          foreignField: "_id",
          as: "prompt"
        }
      },
      { $unwind: { path: "$prompt", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "users",
          localField: "reporterEmail",
          foreignField: "email",
          as: "reporter"
        }
      },
      { $unwind: { path: "$reporter", preserveNullAndEmptyArrays: true } },
      { $sort: { reportedAt: -1 } }
    ]).toArray();
    res.send(reports);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching reports', error });
  }
});

// Get all prompts for Admin (with pagination)
router.get('/admin/prompts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const prompts = await db.collection('prompts').find().sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
    const total = await db.collection('prompts').countDocuments();

    res.send({ data: prompts, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching admin prompts', error });
  }
});

// Get all payments for Admin
router.get('/admin/payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const payments = await db.collection('payments').find().sort({ date: -1 }).toArray();
    res.send(payments);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching payments', error });
  }
});

// Admin Analytics Dashboard
router.get('/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();

    // Aggregate Total Users
    const usersAgg = await db.collection('users').aggregate([{ $count: 'totalUsers' }]).toArray();
    const totalUsers = usersAgg[0]?.totalUsers || 0;

    // Aggregate Total Reviews
    const reviewsAgg = await db.collection('reviews').aggregate([{ $count: 'totalReviews' }]).toArray();
    const totalReviews = reviewsAgg[0]?.totalReviews || 0;

    // Aggregate Revenue
    const revenueAgg = await db.collection('payments').aggregate([
      { $match: { status: 'succeeded' } },
      { $group: { _id: null, totalRevenue: { $sum: "$amount" } } }
    ]).toArray();
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    // Fetch Prompts Stats
    const totalPromptsAgg = await db.collection('prompts').aggregate([{ $count: 'totalPrompts' }]).toArray();
    const totalPrompts = totalPromptsAgg[0]?.totalPrompts || 0;

    // Fetch Total Copies
    const totalCopiesAgg = await db.collection('prompts').aggregate([
      { $group: { _id: null, totalCopies: { $sum: "$copyCount" } } }
    ]).toArray();
    const totalCopies = totalCopiesAgg[0]?.totalCopies || 0;

    // Generate last 6 months chart data
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
      chartDataMap[key] = { name: monthNames[d.getMonth()], users: 0, prompts: 0, order: i };
    }

    // Fetch users grouped by month
    const usersByMonth = await db.collection('users').aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      { $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    usersByMonth.forEach(item => {
      if (item._id.month) {
        const key = `${item._id.year}-${item._id.month - 1}`;
        if (chartDataMap[key]) {
          chartDataMap[key].users = item.count;
        }
      }
    });

    // Fetch prompts grouped by month
    const promptsByMonth = await db.collection('prompts').aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
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

    const chartData = Object.values(chartDataMap).sort((a, b) => a.order - b.order).map(({ name, users, prompts }) => ({ name, users, prompts }));

    // Fetch Engine Prompts & Copies stats
    const engineAgg = await db.collection('prompts').aggregate([
      { 
        $group: { 
          _id: "$aiTool", 
          prompts: { $sum: 1 },
          copies: { $sum: "$copyCount" }
        } 
      }
    ]).toArray();

    const defaultEngines = ["ChatGPT", "Gemini", "Claude", "Stable Diffusion", "Midjourney"];
    const engineMap = {};
    defaultEngines.forEach(e => { engineMap[e] = { name: e, prompts: 0, copies: 0 }; });

    engineAgg.forEach(item => {
      const name = item._id || "Other";
      if (engineMap[name]) {
        engineMap[name].prompts = item.prompts || 0;
        engineMap[name].copies = item.copies || 0;
      } else {
        engineMap[name] = { name, prompts: item.prompts || 0, copies: item.copies || 0 };
      }
    });

    const engineStats = defaultEngines.map(e => engineMap[e]).concat(
      Object.values(engineMap).filter(e => !defaultEngines.includes(e.name))
    );

    res.send({
      totalUsers,
      totalPrompts,
      totalReviews,
      totalRevenue,
      totalCopies,
      chartData,
      engineStats
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching admin analytics', error });
  }
});

router.patch('/admin/prompts/:id/status', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const { status, feedback } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).send({ message: 'Status must be "approved" or "rejected"' });
    }
    
    const updateDoc = { $set: { status } };
    if (status === 'rejected' && feedback) {
      updateDoc.$set.feedback = feedback;
    }
    
    const result = await getDB().collection('prompts').updateOne({ _id: new ObjectId(id) }, updateDoc);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating prompt status', error });
  }
});

// Feature a prompt
router.post('/admin/prompts/:id/feature', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    const isCurrentlyFeatured = prompt.isFeatured || false;

    const result = await db.collection('prompts').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isFeatured: !isCurrentlyFeatured } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error toggling prompt feature', error });
  }
});

// 1.5. Get all users for admin
router.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const users = await db.collection('users').find().sort({ createdAt: -1 }).toArray();
    res.send(users);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching users', error });
  }
});

// 2. Change a user's role
router.patch('/admin/users/:email/role', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const email = req.params.email;
    const { role } = req.body;
    const result = await getDB().collection('users').updateOne(
      { email },
      { $set: { role } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating user role', error });
  }
});

// 3. Delete a user
router.delete('/admin/users/:email', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const email = req.params.email;
    const result = await getDB().collection('users').deleteOne({ email });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error deleting user', error });
  }
});

// 4. Manage reported prompts
router.patch('/admin/reports/:id/manage', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const reportId = req.params.id;
    if (!ObjectId.isValid(reportId)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const { action } = req.body; // 'remove', 'warn', 'dismiss'
    const db = getDB();
    
    const report = await db.collection('reported_prompts').findOne({ _id: new ObjectId(reportId) });
    if (!report) return res.status(404).send({ message: 'Report not found' });
    
    if (action === 'dismiss') {
      await db.collection('reported_prompts').deleteOne({ _id: new ObjectId(reportId) });
      return res.send({ message: 'Report dismissed successfully' });
    } 
    else if (action === 'warn') {
      const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(report.promptId) });
      if (prompt) {
        await db.collection('users').updateOne(
          { email: prompt.creatorEmail },
          { $push: { warnings: { reason: report.reason, date: new Date() } } }
        );
      }
      await db.collection('reported_prompts').updateOne(
        { _id: new ObjectId(reportId) },
        { $set: { status: 'warned_resolved' } }
      );
      return res.send({ message: 'Creator warned and report resolved' });
    } 
    else if (action === 'remove') {
      await db.collection('prompts').deleteOne({ _id: new ObjectId(report.promptId) });
      // Delete all reports related to this prompt
      await db.collection('reported_prompts').deleteMany({ promptId: report.promptId });
      return res.send({ message: 'Prompt removed and related reports deleted' });
    }
    else {
      return res.status(400).send({ message: 'Invalid action specified' });
    }
  } catch (error) {
    res.status(500).send({ message: 'Error managing report', error });
  }
});

// 5. Delete a prompt (Admin)
router.delete('/admin/prompts/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    if (!prompt) return res.status(404).send({ message: 'Prompt not found' });
    
    const result = await db.collection('prompts').deleteOne({ _id: new ObjectId(id) });
    // Cleanup related data
    await db.collection('reviews').deleteMany({ promptId: id });
    await db.collection('bookmarks').deleteMany({ promptId: id });
    await db.collection('reported_prompts').deleteMany({ promptId: id });
    
    res.send({ message: 'Prompt deleted successfully', result });
  } catch (error) {
    res.status(500).send({ message: 'Error deleting prompt', error });
  }
});

// 6. Get System Settings
router.get('/admin/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    let settings = await db.collection('settings').findOne({ type: 'global_settings' });
    if (!settings) {
      settings = {
        siteName: 'PromptNest',
        contactEmail: 'admin@promptnest.com',
        maintenanceMode: false,
        requireEmailVerification: true,
        maxPromptsPerUser: 3
      };
    }
    res.send(settings);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching settings', error });
  }
});

// 7. Save System Settings
router.post('/admin/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { siteName, contactEmail, maintenanceMode, requireEmailVerification, maxPromptsPerUser } = req.body;
    
    const updateDoc = {
      $set: {
        siteName,
        contactEmail,
        maintenanceMode,
        requireEmailVerification,
        maxPromptsPerUser,
        updatedAt: new Date()
      }
    };
    
    const result = await db.collection('settings').updateOne(
      { type: 'global_settings' },
      updateDoc,
      { upsert: true }
    );
    res.send({ message: 'Settings saved successfully', result });
  } catch (error) {
    res.status(500).send({ message: 'Error saving settings', error });
  }
});

module.exports = router;
