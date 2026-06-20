const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getDB } = require('../db');
const { verifyToken } = require('../middlewares/authMiddleware');

const router = express.Router();

// Create Stripe payment intent
router.post('/create-payment-intent', verifyToken, async (req, res) => {
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
router.post('/payments', verifyToken, async (req, res) => {
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

module.exports = router;
