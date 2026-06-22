const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://promt_nest:RIRBId9TQ5ACoGH5@cluster0.mxsiv0y.mongodb.net/?appName=Cluster0";

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('test'); 
    const prompts = await db.collection('prompts').find({}).toArray();
    console.log(`Total prompts: ${prompts.length}`);
    
    for (const prompt of prompts) {
      console.log(`Title: ${prompt.title}`);
      console.log(`Visibility: ${prompt.visibility}`);
      console.log(`Status: ${prompt.status}`);
      console.log(`isFeatured: ${prompt.isFeatured}`);
      console.log(`Featured: ${prompt.featured}`);
      console.log('---');
    }
  } finally {
    await client.close();
  }
}
run().catch(console.dir);
