const express = require('express');
const router = express.Router();
const { handleAccessRequest } = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');

// Route: POST /api/v1/admin/access-request
// Protected by authMiddleware (and potentially checkUserAdminRole inside middleware or controller)
router.post('/access-request', authMiddleware, handleAccessRequest);

module.exports = router;
