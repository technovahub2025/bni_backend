const mongoose = require("mongoose");
const env = require("./env");

async function connectMongo() {
  await mongoose.connect(env.mongoUri);
  return mongoose.connection;
}

module.exports = connectMongo;
