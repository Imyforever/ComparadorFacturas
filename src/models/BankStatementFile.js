const mongoose = require('mongoose');

const bankStatementFileSchema = new mongoose.Schema(
  {
    periodo: {
      type: String,
      required: true,
      index: true // Formato AAAA-MM, ej: "2026-09"
    },
    entidad: {
      type: String,
      default: 'Personal',
      trim: true,
      index: true // Nombre de la pestania/cuenta, ej: "Personal", "Empresa"
    },
    nombreArchivo: {
      type: String,
      required: true
    },
    banco: {
      type: String,
      required: true,
      default: 'Banco'
    },
    cuenta: {
      type: String,
      default: ''
    },
    totalMovimientos: {
      type: Number,
      default: 0
    },
    cargosCount: {
      type: Number,
      default: 0
    },
    abonosCount: {
      type: Number,
      default: 0
    },
    montoCargos: {
      type: Number,
      default: 0
    },
    montoAbonos: {
      type: Number,
      default: 0
    },
    fechaSubida: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

bankStatementFileSchema.index({ periodo: 1, entidad: 1, nombreArchivo: 1 }, { unique: true });

module.exports =
  mongoose.models.BankStatementFile || mongoose.model('BankStatementFile', bankStatementFileSchema);
