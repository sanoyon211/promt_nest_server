const express = require('express');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');

const router = express.Router();

// Fetch top creators
router.get('/creators/top', async (req, res) => {
  try {
    const db = getDB();
    const topCreators = await db.collection('prompts').aggregate([
      { $match: { status: 'approved', visibility: 'Public' } },
      { 
        $group: { 
          _id: "$creatorEmail", 
          promptsCount: { $sum: 1 },
          totalCopies: { $sum: "$copyCount" }
        } 
      },
      { $sort: { totalCopies: -1, promptsCount: -1 } },
      { $limit: 3 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "email",
          as: "userInfo"
        }
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          _id: "$userInfo._id",
          name: "$userInfo.name",
          photoURL: "$userInfo.photoURL",
          role: { 
            $cond: { if: { $eq: ["$userInfo.subscription", "Premium"] }, then: "Pro Creator", else: "Creator" }
          },
          prompts: "$promptsCount",
          email: "$_id"
        }
      }
    ]).toArray();

    const formatted = topCreators.map(c => ({
      id: c._id.toString(),
      name: c.name || c.email.split('@')[0],
      photoURL: c.photoURL,
      role: c.role,
      prompts: c.prompts
    }));

    res.send(formatted);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching top creators', error });
  }
});

// Add a new prompt
router.post('/prompts', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    
    // Check user subscription and prompt count
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(404).send({ message: 'User not found' });
    }
    
    // Extract and format the prompt data
    const {
      title, description, content, category, aiTool, tags, difficultyLevel, difficulty, thumbnailImage, visibility, level
    } = req.body;

    const finalDifficulty = difficultyLevel || difficulty || level || 'Beginner';
    const finalVisibility = visibility || 'Public';

    if (user.subscription === 'Free') {
      if (finalDifficulty === 'Pro' || finalVisibility === 'Private') {
        return res.status(403).send({ message: 'Only Premium users can create Private or Pro prompts.' });
      }

      const promptCount = await db.collection('prompts').countDocuments({ creatorEmail: email });
      if (promptCount >= 3) {
        return res.status(403).send({ message: 'Free users can only add a maximum of 3 prompts.' });
      }
    }
    
    const newPrompt = {
      title,
      description,
      content,
      category,
      aiTool,
      tags: tags || [],
      level: finalDifficulty,
      difficultyLevel: finalDifficulty,
      thumbnailImage,
      visibility: finalVisibility,
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

// Fetch distinct categories and AI tools
router.get('/prompts/filters', async (req, res) => {
  try {
    const db = getDB();
    const categories = await db.collection('prompts').distinct('category');
    const aiTools = await db.collection('prompts').distinct('aiTool');
    
    // Filter out falsy values just in case
    res.send({
      categories: categories.filter(Boolean),
      aiTools: aiTools.filter(Boolean)
    });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching filters', error });
  }
});

// Fetch all public and approved prompts with search, filter, sort, and pagination
router.get('/prompts', async (req, res) => {
  try {
    const db = getDB();
    const {
      search, category, aiTool, difficulty, sort, page = 1, limit = 10
    } = req.query;

    const query = {
      visibility: 'Public',
      status: 'approved'
    };

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { title: searchRegex },
        { tags: searchRegex },
        { aiTool: searchRegex }
      ];
    }

    if (category) query.category = category;
    if (aiTool) query.aiTool = aiTool;
    if (difficulty) query.difficultyLevel = difficulty;

    let sortObj = { createdAt: -1 };
    if (sort === 'most-copied') {
      sortObj = { copyCount: -1 };
    } else if (sort === 'most-popular') {
      sortObj = { rating: -1 };
    } else if (sort === 'latest') {
      sortObj = { createdAt: -1 };
    }

    const pageNumber = parseInt(page);
    const limitNumber = parseInt(limit);
    const skip = (pageNumber - 1) * limitNumber;

    const prompts = await db.collection('prompts')
      .aggregate([
        { $match: query },
        { $sort: sortObj },
        { $skip: skip },
        { $limit: limitNumber },
        {
          $lookup: {
            from: 'users',
            localField: 'creatorEmail',
            foreignField: 'email',
            as: 'creator'
          }
        },
        {
          $unwind: {
            path: '$creator',
            preserveNullAndEmptyArrays: true
          }
        }
      ])
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

// Fetch user's own prompts
router.get('/prompts/my-prompts', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const db = getDB();
    const prompts = await db.collection('prompts').aggregate([
      { $match: { creatorEmail: email } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'creatorEmail',
          foreignField: 'email',
          as: 'creator'
        }
      },
      {
        $unwind: {
          path: '$creator',
          preserveNullAndEmptyArrays: true
        }
      }
    ]).toArray();
    res.send(prompts);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching my prompts', error });
  }
});

// Fetch single prompt by ID with visibility logic
router.get('/prompts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const promptArray = await db.collection('prompts').aggregate([
      { $match: { _id: new ObjectId(id) } },
      {
        $lookup: {
          from: 'users',
          localField: 'creatorEmail',
          foreignField: 'email',
          as: 'creator'
        }
      },
      {
        $unwind: {
          path: '$creator',
          preserveNullAndEmptyArrays: true
        }
      }
    ]).toArray();
    
    const prompt = promptArray[0];

    if (!prompt) {
      return res.status(404).send({ message: 'Prompt not found' });
    }

    // Visibility logic
    if (prompt.visibility === 'Private') {
      let isPremium = false;

      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.split(' ')[1];
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          const user = await db.collection('users').findOne({ email: decoded.email });
          if (user && (user.subscription === 'Premium' || user.email === prompt.creatorEmail)) {
            isPremium = true;
          }
        } catch (e) {
          // Ignore
        }
      }

      if (!isPremium) {
        prompt.content = 'This content is locked. Upgrade to Premium to view.';
        prompt.isLocked = true;
      }
    }

    res.send(prompt);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching prompt', error });
  }
});

// Get bookmark status
router.get('/prompts/:id/bookmark-status', verifyToken, async (req, res) => {
  try {
    const promptId = req.params.id;
    if (!ObjectId.isValid(promptId)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const email = req.decoded.email;
    const db = getDB();
    const bookmark = await db.collection('bookmarks').findOne({ email, promptId });
    res.send({ isBookmarked: !!bookmark });
  } catch (error) {
    res.status(500).send({ message: 'Error fetching bookmark status', error });
  }
});

// Toggle bookmark for a prompt
router.post('/prompts/:id/bookmark', verifyToken, async (req, res) => {
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

// Increment copy count and track copied prompt
router.post('/prompts/:id/copy', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }
    
    const email = req.decoded.email;
    const db = getDB();
    
    // Track the copy
    await db.collection('copied_prompts').insertOne({
      email,
      promptId: id,
      copiedAt: new Date()
    });

    const result = await db.collection('prompts').updateOne(
      { _id: new ObjectId(id) },
      { $inc: { copyCount: 1 } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating copy count', error });
  }
});

// Report a prompt
router.post('/prompts/:id/report', verifyToken, async (req, res) => {
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
    res.send({ message: 'Report submitted successfully', result });
  } catch (error) {
    res.status(500).send({ message: 'Error submitting report', error });
  }
});

// Update own prompt
router.put('/prompts/:id', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID format' });
    
    const db = getDB();
    const prompt = await db.collection('prompts').findOne({ _id: new ObjectId(id) });
    if (!prompt) return res.status(404).send({ message: 'Prompt not found' });
    
    if (prompt.creatorEmail !== req.decoded.email) {
      return res.status(403).send({ message: 'You can only update your own prompts' });
    }
    
    const {
      title, description, content, category, aiTool, tags, difficultyLevel, difficulty, thumbnailImage, visibility, level
    } = req.body;

    const finalDifficulty = difficultyLevel || difficulty || level || prompt.level || prompt.difficultyLevel || 'Beginner';
    const finalVisibility = visibility || prompt.visibility || 'Public';

    const user = await db.collection('users').findOne({ email: req.decoded.email });
    if (user?.subscription === 'Free') {
      if (finalDifficulty === 'Pro' || finalVisibility === 'Private') {
        return res.status(403).send({ message: 'Only Premium users can create or update to Private or Pro prompts.' });
      }
    }
    
    const updateDoc = {
      $set: {
        title: title || prompt.title,
        description: description || prompt.description,
        content: content || prompt.content,
        category: category || prompt.category,
        aiTool: aiTool || prompt.aiTool,
        tags: tags || prompt.tags,
        level: finalDifficulty,
        difficultyLevel: finalDifficulty,
        thumbnailImage: thumbnailImage || prompt.thumbnailImage,
        visibility: visibility || prompt.visibility,
        // Optional: revert to pending status on edit
        // status: 'pending',
        updatedAt: new Date()
      }
    };
    
    const result = await db.collection('prompts').updateOne({ _id: new ObjectId(id) }, updateDoc);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error updating prompt', error });
  }
});

// Delete own prompt
router.delete('/prompts/:id', verifyToken, async (req, res) => {
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

// Add a review for a prompt
router.post('/prompts/:id/reviews', verifyToken, async (req, res) => {
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

// Get all reviews (for homepage slider)
router.get('/reviews', async (req, res) => {
  try {
    const db = getDB();
    // Fetch 15 latest reviews with at least 4 star rating
    const reviews = await db.collection('reviews').aggregate([
      { $match: { rating: { $gte: 4 } } },
      { $sort: { date: -1 } },
      { $limit: 15 },
      {
        $lookup: {
          from: 'users',
          localField: 'email',
          foreignField: 'email',
          as: 'user'
        }
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true
        }
      }
    ]).toArray();
    res.send(reviews);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching recent reviews', error });
  }
});

// Get reviews for a prompt
router.get('/prompts/:id/reviews', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const reviews = await db.collection('reviews').aggregate([
      { $match: { promptId: id } },
      { $sort: { date: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'email',
          foreignField: 'email',
          as: 'user'
        }
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true
        }
      }
    ]).toArray();
    res.send(reviews);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching reviews', error });
  }
});

// Delete own review
router.delete('/reviews/:id', verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid ID format' });
    }

    const db = getDB();
    const review = await db.collection('reviews').findOne({ _id: new ObjectId(id) });
    if (!review) {
      return res.status(404).send({ message: 'Review not found' });
    }

    if (review.email !== req.decoded.email) {
      return res.status(403).send({ message: 'You can only delete your own reviews' });
    }

    const result = await db.collection('reviews').deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error deleting review', error });
  }
});

module.exports = router;
