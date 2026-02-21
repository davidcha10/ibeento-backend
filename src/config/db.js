const mongoose = require('mongoose');

async function connectDB(uri) {
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB conectado');
  } catch (err) {
    console.error('❌ Error conectando a MongoDB:', err.message);
    process.exit(1); // Forzar salida si no conecta
  }
}

module.exports = { connectDB };
