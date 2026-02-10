import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
  CircularProgress,
  Alert,
  Select,
  MenuItem,
  FormControl,
  InputLabel
} from '@mui/material';
import { ArrowBack, CheckCircle, Cancel, Refresh } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import axios from 'axios';
import { URLS } from '../../constants/urls';

interface AccessRequest {
  id: string;
  assetName: string;
  assetType?: string;
  message: string;
  requesterEmail: string;
  projectId: string;
  projectAdmin: string[];
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  autoApproved: boolean;
  requestedRole?: string;
}

const AccessRequestsDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('');

  // Determine user role (admin, manager, or user)
  const userRole = user?.roles?.includes('admin') ? 'admin' :
    user?.roles?.includes('manager') ? 'manager' : 'user';

  useEffect(() => {
    fetchAccessRequests();
  }, [statusFilter, projectFilter]);

  const fetchAccessRequests = async () => {
    setLoading(true);
    setError(null);

    try {
      const params: any = {
        userEmail: user?.email,
        userRole: userRole
      };

      if (statusFilter !== 'all') {
        params.status = statusFilter;
      }

      if (projectFilter) {
        params.projectId = projectFilter;
      }

      const response = await axios.get(`${URLS.API_URL}${URLS.GET_ACCESS_REQUESTS}`, {
        params,
        headers: {
          Authorization: `Bearer ${user?.token}`,
          'x-user-email': user?.email,
          'x-user-role': userRole
        }
      });

      if (response.data.success) {
        setRequests(response.data.data || []);
      } else {
        setError(response.data.error || 'Failed to fetch access requests');
      }
    } catch (err: any) {
      console.error('Error fetching access requests:', err);
      setError(err.response?.data?.error || 'Failed to fetch access requests');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (requestId: string, newStatus: 'approved' | 'rejected') => {
    try {
      const response = await axios.post(`${URLS.API_URL}${URLS.UPDATE_ACCESS_REQUEST}`, {
        requestId,
        status: newStatus,
        reviewerEmail: user?.email
      }, {
        headers: {
          Authorization: `Bearer ${user?.token}`
        }
      });

      if (response.data.success) {
        // Refresh the list
        fetchAccessRequests();
      } else {
        setError(response.data.error || 'Failed to update request');
      }
    } catch (err: any) {
      console.error('Error updating request:', err);
      setError(err.response?.data?.error || 'Failed to update request');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'success';
      case 'rejected':
        return 'error';
      case 'pending':
        return 'warning';
      default:
        return 'default';
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  };

  // Get unique projects for filter
  const uniqueProjects = Array.from(new Set(requests.map(r => r.projectId)));

  return (
    <Box sx={{
      backgroundColor: '#F8FAFD',
      minHeight: '100vh',
      padding: { xs: '0px 0.5rem', sm: '0px 1rem' }
    }}>
      <Box sx={{
        backgroundColor: '#FFFFFF',
        borderRadius: { xs: '16px', sm: '20px' },
        width: '100%',
        minHeight: '95vh',
        padding: { xs: '16px', sm: '24px' },
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
      }}>
        {/* Header */}
        <Box sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '24px'
        }}>
          <IconButton
            onClick={() => navigate('/home')}
            sx={{ color: '#1F1F1F' }}
          >
            <ArrowBack />
          </IconButton>
          <Typography variant="h5" sx={{ fontWeight: 500, color: '#1F1F1F' }}>
            Access Requests Dashboard
          </Typography>
          <IconButton onClick={fetchAccessRequests} sx={{ marginLeft: 'auto' }}>
            <Refresh />
          </IconButton>
        </Box>

        {/* Filters */}
        <Box sx={{
          display: 'flex',
          gap: 2,
          marginBottom: 3,
          flexWrap: 'wrap'
        }}>
          <FormControl sx={{ minWidth: 150 }}>
            <InputLabel>Status</InputLabel>
            <Select
              value={statusFilter}
              label="Status"
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="approved">Approved</MenuItem>
              <MenuItem value="rejected">Rejected</MenuItem>
            </Select>
          </FormControl>

          {userRole === 'admin' && (
            <FormControl sx={{ minWidth: 200 }}>
              <InputLabel>Project</InputLabel>
              <Select
                value={projectFilter}
                label="Project"
                onChange={(e) => setProjectFilter(e.target.value)}
              >
                <MenuItem value="">All Projects</MenuItem>
                {uniqueProjects.map(project => (
                  <MenuItem key={project} value={project}>{project}</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
        </Box>

        {/* Error Alert */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Table */}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', padding: 4 }}>
            <CircularProgress />
          </Box>
        ) : requests.length === 0 ? (
          <Box sx={{ textAlign: 'center', padding: 4 }}>
            <Typography variant="body1" color="text.secondary">
              No access requests found
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper} sx={{ boxShadow: 'none', border: '1px solid #DADCE0' }}>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#F8FAFD' }}>
                  <TableCell><strong>Asset Name</strong></TableCell>
                  <TableCell><strong>Asset Type</strong></TableCell>
                  <TableCell><strong>Requester</strong></TableCell>
                  <TableCell><strong>Project</strong></TableCell>
                  <TableCell><strong>Role</strong></TableCell>
                  <TableCell><strong>Status</strong></TableCell>
                  <TableCell><strong>Submitted</strong></TableCell>
                  <TableCell><strong>Message</strong></TableCell>
                  {(userRole === 'admin' || userRole === 'manager') && (
                    <TableCell><strong>Actions</strong></TableCell>
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {requests.map((request) => (
                  <TableRow key={request.id} hover>
                    <TableCell>
                      <div style={{ fontWeight: 500 }}>{request.assetName}</div>
                      <div style={{ fontSize: '0.75rem', color: '#666' }}>{request.projectId}</div>
                    </TableCell>
                    <TableCell>
                      {request.assetType ? (
                        <Chip label={request.assetType} size="small" variant="outlined" />
                      ) : (
                        <span style={{ color: '#999' }}>-</span>
                      )}
                    </TableCell>
                    <TableCell>{request.requesterEmail}</TableCell>
                    <TableCell>{request.projectId}</TableCell>
                    <TableCell>
                      <Chip
                        label={request.requestedRole || 'roles/bigquery.dataViewer'}
                        size="small"
                        variant="outlined"
                        color="primary"
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={request.status.toUpperCase()}
                        color={getStatusColor(request.status) as any}
                        size="small"
                        icon={request.autoApproved ? <CheckCircle /> : undefined}
                      />
                    </TableCell>
                    <TableCell>{formatDate(request.submittedAt)}</TableCell>
                    <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {request.message || '-'}
                    </TableCell>
                    {(userRole === 'admin' || userRole === 'manager') && (
                      <TableCell>
                        {request.status === 'pending' ? (
                          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            {/* Step 1: Open GCP Link */}
                            <a
                              href="https://new-version-tst-54254020796.europe-west1.run.app"
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                fontSize: '0.75rem',
                                color: '#1976d2',
                                textDecoration: 'none',
                                fontWeight: 'bold',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px'
                              }}
                            >
                              Go to Dataplex UI ↗
                            </a>

                            {/* Step 2: Action Buttons */}
                            <Box sx={{ display: 'flex', gap: 1 }}>
                              <IconButton
                                size="small"
                                sx={{ backgroundColor: '#E6F4EA', color: '#137333', '&:hover': { backgroundColor: '#CEEAD6' } }}
                                onClick={() => handleUpdateStatus(request.id, 'approved')}
                                title="Approve"
                              >
                                <CheckCircle fontSize="small" />
                              </IconButton>
                              <IconButton
                                size="small"
                                sx={{ backgroundColor: '#FCE8E6', color: '#C5221F', '&:hover': { backgroundColor: '#FAD2CF' } }}
                                onClick={() => handleUpdateStatus(request.id, 'rejected')}
                                title="Reject"
                              >
                                <Cancel fontSize="small" />
                              </IconButton>
                            </Box>
                          </Box>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {request.status === 'approved' ? 'Access Granted' : 'Request Rejected'}
                            <br />
                            by {request.reviewedBy}
                          </Typography>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>
    </Box>
  );
};

export default AccessRequestsDashboard;

