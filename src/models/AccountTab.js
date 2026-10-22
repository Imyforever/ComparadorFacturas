const mongoose = require('mongoose');

const accountTabSchema = new mongoose.Schema(
  {
    periodo: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    nombre: {
      type: String,
      required: true,
      trim: true
    },
    descripcion: {
      type: String,
      default: '',
      trim: true
    }
  },
  { timestamps: true }
);

// Asegura que no existan pestanias duplicadas con el mismo nombre en el mismo mes
accountTabSchema.index({ periodo: 1, nombre: 1 }, { unique: true });

module.exports = mongoose.models.AccountTab || mongoose.model('AccountTab', accountTabSchema);
