require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
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
    if (user?.role !== 'Admin') {
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
    if (user?.role !== 'Creator') {
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

// Basic root endpoint
app.get('/', (req, res) => {
  res.send('Server is running');
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
  });
});

