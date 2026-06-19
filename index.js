require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { connectDB, getDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration to allow cross-origin requests securely
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*', // Update this in production to your actual frontend domain
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware to parse JSON
app.use(express.json());

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: 'Unauthorized access' });
    }
    req.decoded = decoded;
    next();
  });
};

// Admin verification middleware
const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const user = await db.collection('users').findOne({ email });
    if (user?.role?.toLowerCase() !== 'admin') {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    next();
  } catch (error) {
    res.status(500).send({ message: 'Error verifying admin role', error });
  }
};

// Creator verification middleware
const verifyCreator = async (req, res, next) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const user = await db.collection('users').findOne({ email });
    if (user?.role?.toLowerCase() !== 'creator' && user?.role?.toLowerCase() !== 'admin') {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    next();
  } catch (error) {
    res.status(500).send({ message: 'Error verifying creator role', error });
  }
};

// Generate JWT endpoint
app.post('/jwt', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).send({ message: 'Email is required' });
  }
  // Token expires in 1 hour
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.send({ token });
});

// Save user details
app.post('/users', async (req, res) => {
  try {
    const user = req.body;
    user.role = user.role || 'User';
    user.subscription = user.subscription || 'Free';
    user.createdAt = new Date();
    
    const db = getDB();
    const existingUser = await db.collection('users').findOne({ email: user.email });
    
    if (existingUser) {
      return res.send({ message: 'User already exists', insertedId: null });
    }
    
    const result = await db.collection('users').insertOne(user);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error saving user', error });
  }
});

// Fetch user details by email
app.get('/users/:email', verifyToken, async (req, res) => {
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

// Add a new prompt
app.post('/prompts', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    
    // Check user subscription and prompt count
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(404).send({ message: 'User not found' });
    }
    
    if (user.subscription === 'Free') {
      const promptCount = await db.collection('prompts').countDocuments({ creatorEmail: email });
      if (promptCount >= 3) {
        return res.status(403).send({ message: 'Free users can only add a maximum of 3 prompts.' });
      }
    }
    
    // Extract and format the prompt data
    const {
      title, description, content, category, aiTool, tags, difficultyLevel, thumbnailImage, visibility
    } = req.body;
    
    const newPrompt = {
      title,
      description,
      content,
      category,
      aiTool,
      tags: tags || [],
      difficultyLevel,
      thumbnailImage,
      visibility: visibility || 'Public',
      status: 'pending',
      copyCount: 0,
      creatorEmail: email,
      createdAt: new Date()
    };
    
    const result = await db.collection('prompts').insertOne(newPrompt);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error adding prompt', error });
  }
});

// Fetch all public and approved prompts with search, filter, sort, and pagination
app.get('/prompts', async (req, res) => {
  try {
    const db = getDB();
    const {
      search,
      category,
      aiTool,
      difficulty,
      sort,
      page = 1,
      limit = 10
    } = req.query;

    // Base query: only public and approved
    const query = {
      visibility: 'Public',
      status: 'approved'
    };

    // 1. Search logic
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { title: searchRegex },
        { tags: searchRegex },
        { aiTool: searchRegex }
      ];
    }

    // 2. Filter logic
    if (category) query.category = category;
    if (aiTool) query.aiTool = aiTool;
    if (difficulty) query.difficultyLevel = difficulty;

    // 3. Sort logic
    let sortObj = { createdAt: -1 }; // Default: Latest
    if (sort === 'most-copied') {
      sortObj = { copyCount: -1 };
    } else if (sort === 'most-popular') {
      sortObj = { rating: -1 }; // Assuming rating exists
    } else if (sort === 'latest') {
      sortObj = { createdAt: -1 };
    }

    // 4. Pagination logic
    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const prompts = await db.collection('prompts')
      .find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limitNumber)
      .toArray();

    const total = await db.collection('prompts').countDocuments(query);

    res.send({
      data: prompts,
      total,
      page: pageNumber,
      totalPages: Math.ceil(total / limitNumber)
    });

  } catch (error) {
    res.status(500).send({ message: 'Error fetching prompts', error });
  }
});

// Fetch single prompt by ID with visibility logic
app.get('/prompts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });

    if (!prompt) {
      return res.status(404).send({ message: 'Prompt not found' });
    }

    // Visibility logic
    if (prompt.visibility === 'Private') {
      let isPremium = false;

      // Check if user is authenticated and has premium
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.split(' ')[1];
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          const user = await db.collection('users').findOne({ email: decoded.email });
          // Let the creator view their own private prompt, or a Premium user
          if (user && (user.subscription === 'Premium' || user.email === prompt.creatorEmail)) {
            isPremium = true;
          }
        } catch (e) {
          // Token invalid or expired, ignore and treat as non-premium
        }
      }

      if (!isPremium) {
        // Return a locked/blurred version
        prompt.content = 'This content is locked. Upgrade to Premium to view.';
        prompt.isLocked = true;
      }
    }

    res.send(prompt);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching prompt', error });
  }
});

// Toggle bookmark for a prompt
app.post('/prompts/:id/bookmark', verifyToken, async (req, res) => {
  try {
    const promptId = req.params.id;
    if (!ObjectId.isValid(promptId)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }
    
    const email = req.decoded.email;
    const db = getDB();
    
    const bookmark = await db.collection('bookmarks').findOne({ email, promptId });
    if (bookmark) {
      await db.collection('bookmarks').deleteOne({ _id: bookmark._id });
      res.send({ message: 'Bookmark removed', isBookmarked: false });
    } else {
      await db.collection('bookmarks').insertOne({ email, promptId, createdAt: new Date() });
      res.send({ message: 'Bookmark added', isBookmarked: true });
    }
  } catch (error) {
    res.status(500).send({ message: 'Error toggling bookmark', error });
  }
});

// Increment copy count
app.patch('/prompts/:id/copy', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }
    
    const db = getDB();
    const result = await db.collection('prompts').updateOne(
      { _id: new ObjectId(id) },
      { $inc: { copyCount: 1 } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating copy count', error });
  }
});

// Add a review for a prompt
app.post('/prompts/:id/reviews', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    if (!prompt) {
      return res.status(404).send({ message: 'Prompt not found' });
    }

    // Check visibility / access
    if (prompt.visibility === 'Private') {
      const email = req.decoded.email;
      const user = await db.collection('users').findOne({ email });
      const isPremium = user && (user.subscription === 'Premium' || user.email === prompt.creatorEmail);
      if (!isPremium) {
        return res.status(403).send({ message: 'You must have access to the full prompt to review it.' });
      }
    }

    const { rating, comment, name } = req.body;
    const review = {
      promptId: id,
      rating,
      comment,
      name,
      email: req.decoded.email,
      date: new Date()
    };

    const result = await db.collection('reviews').insertOne(review);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error submitting review', error });
  }
});

// Get reviews for a prompt
app.get('/prompts/:id/reviews', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const reviews = await db.collection('reviews').find({ promptId: id }).sort({ date: -1 }).toArray();
    res.send(reviews);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching reviews', error });
  }
});

// Report a prompt
app.post('/prompts/:id/report', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const { reason, description } = req.body;
    if (!reason) {
      return res.status(400).send({ message: 'Report reason is required' });
    }

    const db = getDB();
    const report = {
      promptId: id,
      reporterEmail: req.decoded.email,
      reason,
      description: description || '',
      reportedAt: new Date()
    };

    const result = await db.collection('reported_prompts').insertOne(report);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error submitting report', error });
  }
});

// Create Stripe payment intent
app.post('/create-payment-intent', verifyToken, async (req, res) => {
  try {
    const amount = 500; // $5.00 in cents
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      payment_method_types: ['card']
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).send({ message: 'Error creating payment intent', error });
  }
});

// Save successful payment and upgrade subscription
app.post('/payments', verifyToken, async (req, res) => {
  try {
    const { transactionId, amount } = req.body;
    const email = req.decoded.email;
    const db = getDB();
    
    // Save transaction record
    const newPayment = {
      transactionId,
      email,
      amount,
      date: new Date()
    };
    await db.collection('payments').insertOne(newPayment);

    // Update user subscription to Premium
    const updateResult = await db.collection('users').updateOne(
      { email },
      { $set: { subscription: 'Premium' } }
    );

    res.send({ message: 'Payment successful, subscription upgraded to Premium', newPayment, updateResult });
  } catch (error) {
    res.status(500).send({ message: 'Error saving payment', error });
  }
});

// Admin Analytics Dashboard
app.get('/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();

    // Aggregate Total Users
    const usersAgg = await db.collection('users').aggregate([
      { $count: 'totalUsers' }
    ]).toArray();
    const totalUsers = usersAgg[0]?.totalUsers || 0;

    // Aggregate Total Reviews
    const reviewsAgg = await db.collection('reviews').aggregate([
      { $count: 'totalReviews' }
    ]).toArray();
    const totalReviews = reviewsAgg[0]?.totalReviews || 0;

    // Aggregate Total Prompts and Total Copies
    const promptsAgg = await db.collection('prompts').aggregate([
      {
        $group: {
          _id: null,
          totalPrompts: { $sum: 1 },
          totalCopies: { $sum: '$copyCount' }
        }
      }
    ]).toArray();
    
    const totalPrompts = promptsAgg[0]?.totalPrompts || 0;
    const totalCopies = promptsAgg[0]?.totalCopies || 0;

    res.send({
      totalUsers,
      totalPrompts,
      totalReviews,
      totalCopies
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching analytics', error });
  }
});

// Creator Analytics Dashboard
app.get('/creator/analytics', verifyToken, verifyCreator, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();

    // Aggregate Total Prompts and Total Copies for this creator
    const promptsAgg = await db.collection('prompts').aggregate([
      { $match: { creatorEmail: email } },
      {
        $group: {
          _id: null,
          totalPrompts: { $sum: 1 },
          totalCopies: { $sum: '$copyCount' }
        }
      }
    ]).toArray();
    
    const totalPrompts = promptsAgg[0]?.totalPrompts || 0;
    const totalCopies = promptsAgg[0]?.totalCopies || 0;

    // Aggregate Total Bookmarks for this creator's prompts
    const bookmarksAgg = await db.collection('bookmarks').aggregate([
      {
        $lookup: {
          from: 'prompts',
          let: { pid: { $toObjectId: '$promptId' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$pid'] } } }
          ],
          as: 'promptDetails'
        }
      },
      { $unwind: '$promptDetails' },
      { $match: { 'promptDetails.creatorEmail': email } },
      { $count: 'totalBookmarks' }
    ]).toArray();
    
    const totalBookmarks = bookmarksAgg[0]?.totalBookmarks || 0;

    // Recharts data: Prompt Growth over time
    const chartData = await db.collection('prompts').aggregate([
      { $match: { creatorEmail: email } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          promptsAdded: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          date: '$_id',
          promptsAdded: 1,
          _id: 0
        }
      }
    ]).toArray();

    res.send({
      totalPrompts,
      totalCopies,
      totalBookmarks,
      chartData
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching creator analytics', error });
  }
});

// 1. Approve/Reject a prompt
app.patch('/admin/prompts/:id/status', verifyToken, verifyAdmin, async (req, res) => {
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

// 1.5. Get all users for admin
app.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const users = await db.collection('users').find().sort({ createdAt: -1 }).toArray();
    res.send(users);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching users', error });
  }
});

// 2. Change a user's role
app.patch('/admin/users/:email/role', verifyToken, verifyAdmin, async (req, res) => {
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
app.delete('/admin/users/:email', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const email = req.params.email;
    const result = await getDB().collection('users').deleteOne({ email });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error deleting user', error });
  }
});

// 4. Manage reported prompts
app.patch('/admin/reports/:id/manage', verifyToken, verifyAdmin, async (req, res) => {
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

// Update own prompt
app.put('/prompts/:id', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    if (!prompt) return res.status(404).send({ message: 'Prompt not found' });
    
    if (prompt.creatorEmail !== req.decoded.email) {
      return res.status(403).send({ message: 'You can only update your own prompts' });
    }
    
    // Prevent updating restricted fields
    const { _id, creatorEmail, createdAt, copyCount, status, ...updateFields } = req.body;
    updateFields.updatedAt = new Date();
    
    const result = await db.collection('prompts').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating prompt', error });
  }
});

// Delete own prompt
app.delete('/prompts/:id', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    if (!prompt) return res.status(404).send({ message: 'Prompt not found' });
    
    if (prompt.creatorEmail !== req.decoded.email) {
      return res.status(403).send({ message: 'You can only delete your own prompts' });
    }
    
    const result = await db.collection('prompts').deleteOne({ _id: new ObjectId(id) });
    // Also cleanup related data
    await db.collection('reviews').deleteMany({ promptId: id });
    await db.collection('bookmarks').deleteMany({ promptId: id });
    await db.collection('reported_prompts').deleteMany({ promptId: id });
    
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error deleting prompt', error });
  }
});

// Basic root endpoint
app.get('/', (req, res) => {
  res.send('Server is running');
});

// 404 Route Handler
app.use((req, res, next) => {
  res.status(404).send({ message: 'API Route Not Found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).send({
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err : {}
  });
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
  });
});

