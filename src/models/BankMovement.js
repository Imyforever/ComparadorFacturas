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
    // Mes al que se subio el archivo de origen (un estado de cuenta puede abarcar 2 meses)
    archivoPeriodo: {
      type: String
    },
    // Identificador estable del movimiento para evitar duplicados al re-subir archivos
    huella: {
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

bankMovementSchema.index({ periodo: 1, entidad: 1, tipo: 1, conciliado: 1 });
bankMovementSchema.index({ entidad: 1, huella: 1 });
bankMovementSchema.index({ entidad: 1, archivoOrigen: 1 });

module.exports = mongoose.models.BankMovement || mongoose.model('BankMovement', bankMovementSchema);
