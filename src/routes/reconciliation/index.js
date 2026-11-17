/**
 * Enrutador principal de conciliacion que agrupa las subrutas por recurso.
 */

const express = require('express');
const tabsRoutes = require('./tabs');
const dataRoutes = require('./data');
const linksRoutes = require('./links');
const egresosRoutes = require('./egresos');
const uploadsRoutes = require('./uploads');
const invoicesRoutes = require('./invoices');
const exportRoutes = require('./export');

const router = express.Router();

router.use(tabsRoutes);
router.use(dataRoutes);
router.use(linksRoutes);
router.use(egresosRoutes);
router.use(uploadsRoutes);
router.use(invoicesRoutes);
router.use(exportRoutes);

module.exports = router;
