require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
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

// Basic root endpoint
app.get('/', (req, res) => {
  res.send('Server is running');
});

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
  });
});

