const mongoose = require('mongoose');

const bankMovementSchema = new mongoose.Schema(
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
    banco: {
      type: String,
      required: true,
      default: 'Scotiabank'
    },
    cuenta: {
      type: String
    },
    fecha: {
      type: String,
      required: true
    },
    fechaNormalizada: {
      type: Date
    },
    tipo: {
      type: String,
      enum: ['Retiro', 'Deposito'],
      required: true,
      index: true
    },
    monto: {
      type: Number,
      required: true,
      index: true
    },
    saldo: {
      type: Number
    },
    concepto: {
      type: String,
      required: true,
      trim: true
    },
    origenReferencia: {
      type: String
    },
    rfcDetectado: {
      type: String,
      uppercase: true,
      trim: true
    },
    conciliado: {
      type: Boolean,
      default: false,
      index: true
    },
    facturaUuid: {
      type: String,
      ref: 'Invoice'
    },
    archivoOrigen: {
      type: String
    },
    observaciones: {
      type: String,
      default: ''
    },
    categoria: {
      type: String,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.models.BankMovement || mongoose.model('BankMovement', bankMovementSchema);
