const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema(
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
    uuid: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true
    },
    emisor: {
      type: String,
      required: true,
      trim: true
    },
    rfcEmisor: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true
    },
    receptor: {
      type: String,
      trim: true
    },
    rfcReceptor: {
      type: String,
      trim: true,
      uppercase: true
    },
    fechaEmision: {
      type: String,
      required: true
    },
    fechaCertificacion: {
      type: String
    },
    total: {
      type: Number,
      required: true,
      index: true
    },
    pac: {
      type: String
    },
    estadoSat: {
      type: String,
      enum: ['Vigente', 'Cancelado'],
      default: 'Vigente'
    },
    efecto: {
      type: String,
      enum: ['Ingreso', 'Egreso', 'Pago', 'Nomina', 'Traslado'],
      default: 'Ingreso'
    },
    motivoCancelacion: {
      type: String
    },
    // Estado de conciliacion bancaria
    estadoPago: {
      type: String,
      enum: ['Pagada', 'No Pagada', 'Cancelada', 'Pago Parcial', 'No Aplica', 'En Revision'],
      default: 'No Pagada',
      index: true
    },
    // Modificacion manual por el usuario
    editadoManualmente: {
      type: Boolean,
      default: false
    },
    fechaEdicionManual: {
      type: Date
    },
    // Observaciones o notas del usuario
    observaciones: {
      type: String,
      default: '',
      trim: true
    },
    // Datos del movimiento bancario que liquido la factura
    pagoAsociado: {
      movimientoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BankMovement'
      },
      banco: String,
      fechaPago: String,
      montoRetiro: Number,
      diferencia: Number,
      conceptoBanco: String,
      referencia: String
    }
  },
  {
    timestamps: true
  }
);

// Consultas principales: por mes + pestania
invoiceSchema.index({ periodo: 1, entidad: 1, fechaEmision: 1 });
invoiceSchema.index({ 'pagoAsociado.movimientoId': 1 });

module.exports = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
