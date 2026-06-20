const jwt = require('jsonwebtoken');
const { getDB } = require('../db');

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

module.exports = { verifyToken, verifyAdmin, verifyCreator };
