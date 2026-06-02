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
  InputLabel,
  Tabs,
  Tab,
  Button,
  TextField,
  InputAdornment,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Autocomplete
} from '@mui/material';
import { ArrowBack, CheckCircle, Cancel, Refresh, Person, Assignment, AdminPanelSettings, Search, Add, DeleteOutline } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import axios from 'axios';
import { URLS } from '../../constants/urls';
import SubmitAccess from '../SearchPage/SubmitAccess';

interface AccessRequest {
  id: string;
  assetName: string;
  assetType?: string;
  message: string;
  requesterEmail: string;
  projectId: string;
  projectAdmin: string[];
  status: 'pending' | 'partially_approved' | 'approved' | 'rejected' | 'revoked';
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  autoApproved: boolean;
  requestedRole?: string;
  approvals?: string[]; // Emails of stewards who already approved
  serviceNowTicket?: string;
  serviceNowSysId?: string;
  serviceNowState?: string;
  serviceNowLink?: string;
}

const AccessRequestsDashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [tabValue, setTabValue] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [isNewRequestOpen, setIsNewRequestOpen] = useState<boolean>(false);
  const [newRequestAssetName, setNewRequestAssetName] = useState<string>('');
  const [newRequestDialogOpen, setNewRequestDialogOpen] = useState<boolean>(false);
  // Searchable asset picker for the New Request dialog.
  const [assetInput, setAssetInput] = useState<string>('');
  const [assetOptions, setAssetOptions] = useState<{ label: string; value: string; sub: string; entry?: any }[]>([]);
  const [assetSearching, setAssetSearching] = useState<boolean>(false);
  const [selectedAssetEntry, setSelectedAssetEntry] = useState<any>(null);

  // Admin status can arrive asynchronously (set elsewhere after /admin/check),
  // which made this page flip between admin and non-admin views. Resolve it here
  // too so the dashboard is consistent regardless of how the user navigated in.
  const [resolvedIsAdmin, setResolvedIsAdmin] = useState<boolean>(!!user?.isAdmin);
  useEffect(() => {
    if (!user?.email || !user?.token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${URLS.API_URL}${URLS.ADMIN_CHECK}`, {
          params: { email: user.email },
          headers: { Authorization: `Bearer ${user.token}`, 'x-user-email': user.email || '' },
        });
        if (!cancelled) setResolvedIsAdmin(!!(res.data?.isAdmin || res.data?.hasAdminCapabilities));
      } catch { /* keep whatever we have */ }
    })();
    return () => { cancelled = true; };
  }, [user?.email, user?.token]);

  // Determine user role (admin, manager, or user)
  const userRole = (resolvedIsAdmin || user?.isAdmin || user?.role === 'admin' || user?.role === 'manager') ? 'admin' : 'user';

  useEffect(() => {
    fetchAccessRequests();
  }, [user?.email, userRole, statusFilter, projectFilter]);

  // Debounced asset search for the New Request picker: type "banque" and pick a
  // table/dataset from the dropdown instead of typing the full name by hand.
  useEffect(() => {
    if (!newRequestDialogOpen) return;
    const term = assetInput.trim();
    if (term.length < 2) { setAssetOptions([]); return; }
    let cancelled = false;
    setAssetSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await axios.post(`${URLS.API_URL}${URLS.SEARCH}`, {
          query: term, pageSize: 20, orderBy: 'relevance', semanticSearch: true,
        }, { headers: { Authorization: `Bearer ${user?.token}`, 'x-user-email': user?.email } });
        if (cancelled) return;
        const results = res.data?.results || [];
        const opts = results.map((r: any) => {
          const e = r.dataplexEntry || r;
          const fqn = (e.fullyQualifiedName || '').replace(/^bigquery:/, '');
          const display = e.entrySource?.displayName || fqn.split('.').pop() || fqn;
          const type = (e.entryType || '').split('/').pop() || '';
          return { label: display, value: fqn || display, sub: `${type ? type + ' · ' : ''}${fqn}`, entry: e };
        }).filter((o: any) => o.value);
        // De-duplicate by value.
        const seen = new Set<string>();
        setAssetOptions(opts.filter((o: any) => (seen.has(o.value) ? false : (seen.add(o.value), true))));
      } catch {
        if (!cancelled) setAssetOptions([]);
      } finally {
        if (!cancelled) setAssetSearching(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [assetInput, newRequestDialogOpen, user?.email, user?.token]);

  // Statuses that represent "awaiting action" (needs approval or rejection)
  const AWAITING_STATUSES = ['PENDING', 'PARTIALLY_APPROVED'];

  const fetchAccessRequests = async () => {
    setLoading(true);
    setError(null);

    try {
      const params: any = {
        userEmail: user?.email,
        userRole: userRole
      };

      // Only send specific status to backend; 'all' and 'awaiting' are handled client-side
      if (statusFilter !== 'all' && statusFilter !== 'awaiting') {
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

  // Reject dialog state
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectRequestId, setRejectRequestId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const handleUpdateStatus = async (requestId: string, newStatus: 'approved' | 'rejected' | 'revoked', reason?: string) => {
    try {
      const response = await axios.post(`${URLS.API_URL}${URLS.UPDATE_ACCESS_REQUEST}`, {
        requestId,
        status: newStatus.toUpperCase(),
        reviewerEmail: user?.email,
        ...(reason ? { adminNote: reason } : {})
      }, {
        headers: {
          Authorization: `Bearer ${user?.token}`,
          'x-user-email': user?.email
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

  // Delete a single access request (does not change any granted IAM).
  const handleDeleteRequest = async (requestId: string) => {
    if (!window.confirm('Delete this access request? This only removes the request record, not any access already granted.')) return;
    try {
      await axios.delete(`${URLS.API_URL}${URLS.DELETE_ACCESS_REQUEST}/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${user?.token}`, 'x-user-email': user?.email }
      });
      fetchAccessRequests();
    } catch (err: any) {
      console.error('Error deleting request:', err);
      setError(err.response?.data?.error || 'Failed to delete request');
    }
  };

  // Delete ALL requests for a requester email (demo cleanup).
  const handleDeleteAllForEmail = async () => {
    const email = window.prompt('Delete ALL access requests for which requester email? (demo cleanup)');
    if (!email || !email.trim()) return;
    try {
      const res = await axios.post(`${URLS.API_URL}${URLS.DELETE_ACCESS_REQUESTS_BY_EMAIL}`, { email: email.trim() }, {
        headers: { Authorization: `Bearer ${user?.token}`, 'x-user-email': user?.email }
      });
      setError(null);
      alert(`Deleted ${res.data?.deleted ?? 0} request(s) for ${email.trim()}.`);
      fetchAccessRequests();
    } catch (err: any) {
      console.error('Error deleting requests for email:', err);
      setError(err.response?.data?.error || 'Failed to delete requests');
    }
  };

  const getStatusColor = (status: string) => {
    const s = status?.toUpperCase();
    switch (s) {
      case 'APPROVED':
        return 'success';
      case 'PARTIALLY_APPROVED':
        return 'info';
      case 'REJECTED':
        return 'error';
      case 'PENDING':
        return 'warning';
      case 'REVOKED':
        return 'secondary';
      default:
        return 'default';
    }
  };

  const getStatusLabel = (request: AccessRequest) => {
    const s = request.status?.toUpperCase();
    if (s === 'PARTIALLY_APPROVED') {
      const count = request.approvals?.length || 0;
      const threshold = Math.max(1, Math.min(request.projectAdmin?.length || 2, 2));
      return `CONSENSUS (${count}/${threshold})`;
    }
    return s || '';
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
  const uniqueProjects = Array.from(new Set(requests.map((r: AccessRequest) => r.projectId)));

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const filteredRequests = requests.filter((req: AccessRequest) => {
    const isAdmin = userRole === 'admin';
    let passesTab = true;

    if (isAdmin) {
      // If admin, they have two tabs: 0 = Management, 1 = My Requests
      if (tabValue === 1) {
        passesTab = req.requesterEmail === user?.email;
      }
    } else {
      // If not admin, they only have one tab: 0 = My Requests
      passesTab = req.requesterEmail === user?.email;
    }

    if (!passesTab) return false;

    // Apply status filter (client-side for 'awaiting' virtual filter)
    if (statusFilter === 'awaiting') {
      if (!AWAITING_STATUSES.includes(req.status?.toUpperCase())) return false;
    } else if (statusFilter !== 'all') {
      if (req.status?.toUpperCase() !== statusFilter.toUpperCase()) return false;
    }

    // Apply text search filter
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      return (
        req.assetName.toLowerCase().includes(search) ||
        req.requesterEmail.toLowerCase().includes(search) ||
        req.projectId.toLowerCase().includes(search) ||
        (req.assetType && req.assetType.toLowerCase().includes(search))
      );
    }

    return true;
  });

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
            Access Requests
          </Typography>
          {user?.isAdmin && (
            <Button
              variant="outlined"
              size="small"
              onClick={() => navigate('/admin-access')}
              sx={{ ml: 2, borderRadius: '20px', textTransform: 'none' }}
              startIcon={<AdminPanelSettings />}
            >
              Admin Management
            </Button>
          )}
          <Button
            variant="contained"
            size="small"
            onClick={() => setNewRequestDialogOpen(true)}
            sx={{ ml: 'auto', borderRadius: '20px', textTransform: 'none' }}
            startIcon={<Add />}
          >
            New Request
          </Button>
          {userRole === 'admin' && (
            <Tooltip title="Delete all requests for a requester (demo cleanup)">
              <Button
                variant="outlined"
                size="small"
                color="error"
                onClick={handleDeleteAllForEmail}
                sx={{ borderRadius: '20px', textTransform: 'none' }}
                startIcon={<DeleteOutline />}
              >
                Clear account
              </Button>
            </Tooltip>
          )}
          <IconButton onClick={fetchAccessRequests}>
            <Refresh />
          </IconButton>
        </Box>

        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
          <Tabs value={tabValue} onChange={handleTabChange} aria-label="access request tabs">
            {userRole === 'admin' && (
              <Tab label="Access Management" icon={<Assignment />} iconPosition="start" />
            )}
            <Tab label="My Requests" icon={<Person />} iconPosition="start" />
          </Tabs>
        </Box>

        {/* Filters */}
        <Box sx={{
          display: 'flex',
          gap: 2,
          marginBottom: 3,
          flexWrap: 'wrap',
          alignItems: 'center'
        }}>
          <Box sx={{ flexGrow: 1, minWidth: 250 }}>
            <TextField
              fullWidth
              size="small"
              placeholder="Search by email, asset or project..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <Search sx={{ color: 'text.secondary', fontSize: 20 }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  borderRadius: '20px',
                  backgroundColor: '#F1F3F4',
                  '& fieldset': { border: 'none' }
                }
              }}
            />
          </Box>
          <FormControl sx={{ minWidth: 150 }} size="small">
            <InputLabel>Status</InputLabel>
            <Select
              value={statusFilter}
              label="Status"
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <MenuItem value="awaiting">Awaiting Action</MenuItem>
              <MenuItem value="all">All Status</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="partially_approved">Partially Approved</MenuItem>
              <MenuItem value="approved">Approved</MenuItem>
              <MenuItem value="rejected">Rejected</MenuItem>
              <MenuItem value="revoked">Revoked</MenuItem>
            </Select>
          </FormControl>

          {userRole === 'admin' && (
            <FormControl sx={{ minWidth: 200 }} size="small">
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
        ) : filteredRequests.length === 0 ? (
          <Box sx={{ textAlign: 'center', padding: 4 }}>
            <Typography variant="body1" color="text.secondary">
              No access requests found
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper} sx={{ boxShadow: 'none', border: '1px solid #DADCE0', borderRadius: '12px', overflow: 'hidden' }}>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#F8FAFD' }}>
                  <TableCell><strong>Asset Name</strong></TableCell>
                  <TableCell><strong>Asset Type</strong></TableCell>
                  <TableCell><strong>Requester</strong></TableCell>
                  <TableCell><strong>Status</strong></TableCell>
                  <TableCell><strong>Submitted</strong></TableCell>
                  <TableCell><strong>Message</strong></TableCell>
                  <TableCell align="right"><strong>Actions</strong></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredRequests.map((request: AccessRequest) => (
                  <TableRow key={request.id} hover>
                    <TableCell>
                      <div style={{ fontWeight: 500, color: '#1F1F1F' }}>{request.assetName}</div>
                      <div style={{ fontSize: '0.75rem', color: '#5F6368' }}>{request.projectId}</div>
                    </TableCell>
                    <TableCell>
                      {request.assetType === 'data_product' ? (
                        <Chip label="Data Product" size="small" sx={{ fontSize: '11px', height: '22px', backgroundColor: '#e8f0fe', color: '#1967d2', fontWeight: 600 }} />
                      ) : request.assetType ? (
                        <Chip label={request.assetType} size="small" variant="outlined" sx={{ fontSize: '11px', height: '22px' }} />
                      ) : (
                        <Typography variant="caption" sx={{ color: '#9AA0A6' }}>—</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ color: '#1F1F1F' }}>{request.requesterEmail}</Typography>
                      {request.serviceNowTicket && (
                        request.serviceNowTicket === 'ERROR-CREATING-SN' ? (
                          <Tooltip title="Failed to create ServiceNow ticket. Check ServiceNow configuration.">
                            <Chip
                              label="SN: Error"
                              size="small"
                              variant="outlined"
                              sx={{
                                fontSize: '10px', height: '20px', mt: 0.5,
                                borderColor: '#EA4335', color: '#EA4335',
                                cursor: 'default'
                              }}
                            />
                          </Tooltip>
                        ) : request.serviceNowTicket.startsWith('MOCK-SN-') ? (
                          <Tooltip title="ServiceNow integration is not configured. Contact your administrator to enable it.">
                            <Chip
                              label="SN: Not configured"
                              size="small"
                              variant="outlined"
                              sx={{
                                fontSize: '10px', height: '20px', mt: 0.5,
                                borderColor: '#9AA0A6', color: '#9AA0A6',
                                cursor: 'default'
                              }}
                            />
                          </Tooltip>
                        ) : (
                          <Tooltip title={`ServiceNow: ${request.serviceNowState || 'Click to view'}`}>
                            <Chip
                              label={`SN: ${request.serviceNowTicket}${request.serviceNowState ? ' - ' + request.serviceNowState : ''}`}
                              size="small"
                              variant="outlined"
                              clickable={!!request.serviceNowLink}
                              onClick={() => request.serviceNowLink && window.open(request.serviceNowLink, '_blank')}
                              sx={{
                                fontSize: '10px', height: '20px', mt: 0.5,
                                borderColor: request.serviceNowState === 'Approved' ? '#34A853' :
                                  request.serviceNowState === 'Rejected' ? '#EA4335' : '#1A73E8',
                                color: request.serviceNowState === 'Approved' ? '#34A853' :
                                  request.serviceNowState === 'Rejected' ? '#EA4335' : '#1A73E8',
                                cursor: request.serviceNowLink ? 'pointer' : 'default'
                              }}
                            />
                          </Tooltip>
                        )
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={getStatusLabel(request)}
                        color={getStatusColor(request.status) as any}
                        size="small"
                        sx={{ fontWeight: 500, fontSize: '0.7rem' }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(request.submittedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <Typography variant="body2" color="text.secondary">
                        {request.message || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                     <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 }}>
                      {userRole === 'admin' && (
                        (request.status?.toLowerCase() === 'pending' || request.status?.toLowerCase() === 'partially_approved') ? (
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                            <Button
                              size="small"
                              variant="contained"
                              color="success"
                              disabled={request.approvals?.includes(user?.email || '')}
                              startIcon={<CheckCircle sx={{ fontSize: '16px !important' }} />}
                              onClick={() => handleUpdateStatus(request.id, 'approved')}
                              sx={{ textTransform: 'none', borderRadius: '16px', py: 0 }}
                            >
                              {request.status?.toLowerCase() === 'partially_approved'
                                ? `Confirm (${(request.approvals?.length || 0) + 1}/${Math.max(1, Math.min(request.projectAdmin?.length || 2, 2))})`
                                : 'Approve'}
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              color="error"
                              startIcon={<Cancel sx={{ fontSize: '16px !important' }} />}
                              onClick={() => { setRejectRequestId(request.id); setRejectReason(''); setRejectDialogOpen(true); }}
                              sx={{ textTransform: 'none', borderRadius: '16px', py: 0 }}
                            >
                              Reject
                            </Button>
                          </Box>
                        ) : request.status?.toLowerCase() === 'approved' ? (
                          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, alignItems: 'center' }}>
                            <Typography variant="caption" sx={{ color: '#5F6368', mr: 1 }}>
                              Granted {request.reviewedBy ? `by ${request.reviewedBy.split('@')[0]}` : ''}
                            </Typography>
                            <Button
                              size="small"
                              variant="outlined"
                              color="warning"
                              onClick={() => handleUpdateStatus(request.id, 'revoked')}
                              sx={{ textTransform: 'none', borderRadius: '16px', py: 0 }}
                            >
                              Revoke
                            </Button>
                          </Box>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {request.status?.toLowerCase() === 'revoked' ? 'Access Revoked' : 'Rejected'}
                          </Typography>
                        )
                      )}
                      {(userRole === 'admin' || request.requesterEmail === user?.email) && (
                        <Tooltip title="Delete request">
                          <IconButton size="small" onClick={() => handleDeleteRequest(request.id)} sx={{ color: '#5f6368' }}>
                            <DeleteOutline fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                     </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      {/* Reject Confirmation Dialog */}
      <Dialog open={rejectDialogOpen} onClose={() => setRejectDialogOpen(false)}>
        <DialogTitle>Reject Access Request</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>Are you sure you want to reject this access request?</Typography>
          <TextField
            label="Reason (optional)"
            fullWidth
            multiline
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Provide a reason for rejection..."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectDialogOpen(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => { if (rejectRequestId) { handleUpdateStatus(rejectRequestId, 'rejected', rejectReason); setRejectDialogOpen(false); } }}
          >
            Reject
          </Button>
        </DialogActions>
      </Dialog>
      {/* New Request: enter asset name dialog */}
      <Dialog open={newRequestDialogOpen} onClose={() => setNewRequestDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Request Access to a Dataset or Table</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Search for the table or dataset you need (e.g. type <em>banque</em>), then pick it from the list. You can also type the full name manually.
          </Typography>
          <Autocomplete
            freeSolo
            autoHighlight
            options={assetOptions}
            loading={assetSearching}
            filterOptions={(x) => x}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.value)}
            renderOption={(props, o) => (
              <li {...props} key={o.value}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>{o.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{o.sub}</Typography>
                </Box>
              </li>
            )}
            onInputChange={(_e, v) => { setAssetInput(v); setNewRequestAssetName(v); }}
            onChange={(_e, v) => {
              const val = typeof v === 'string' ? v : (v?.value || '');
              setNewRequestAssetName(val);
              setSelectedAssetEntry(typeof v === 'string' ? null : (v?.entry || null));
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                label="Search for a table or dataset"
                placeholder="e.g. banque"
                size="small"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {assetSearching ? <CircularProgress color="inherit" size={16} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewRequestDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newRequestAssetName.trim()}
            onClick={() => {
              setNewRequestDialogOpen(false);
              setIsNewRequestOpen(true);
            }}
          >
            Continue
          </Button>
        </DialogActions>
      </Dialog>

      {/* SubmitAccess panel for new requests */}
      <SubmitAccess
        isOpen={isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        assetName={newRequestAssetName}
        entry={selectedAssetEntry}
        previewData={selectedAssetEntry}
        onSubmitSuccess={() => {
          setIsNewRequestOpen(false);
          setNewRequestAssetName('');
          setSelectedAssetEntry(null);
          fetchAccessRequests();
        }}
      />
    </Box>
  );
};

export default AccessRequestsDashboard;

