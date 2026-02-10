import { useState, useEffect, useCallback } from 'react';
import {
  IconButton,
  Badge,
  Popover,
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider,
  Button,
  CircularProgress,
} from '@mui/material';
import {
  Notifications as NotificationsIcon,
  CheckCircle,
  Cancel,
  RemoveCircle,
  FiberNew,
  DoneAll,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useAppDispatch, useAppSelector } from '../../app/store';
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationsRead,
  markAllNotificationsRead,
  type PersistentNotification,
} from '../../features/admin/adminSlice';

const NOTIFICATION_ICONS: Record<string, React.ReactNode> = {
  ACCESS_APPROVED: <CheckCircle sx={{ color: '#137333' }} />,
  ACCESS_REJECTED: <Cancel sx={{ color: '#C5221F' }} />,
  ACCESS_REVOKED: <RemoveCircle sx={{ color: '#E37400' }} />,
  NEW_REQUEST: <FiberNew sx={{ color: '#0E4DCA' }} />,
  BULK_ACTION: <DoneAll sx={{ color: '#0E4DCA' }} />,
};

const NotificationCenter = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  const { notifications, unreadCount } = useAppSelector((state) => state.admin);

  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(false);

  const token = user?.token || '';
  const email = user?.email || '';

  const loadNotifications = useCallback(async () => {
    if (!token || !email) return;
    setLoading(true);
    try {
      await dispatch(fetchNotifications({ token, email, limit: 20 }));
      await dispatch(fetchUnreadCount({ token, email }));
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [dispatch, token, email]);

  // Initial load and polling
  useEffect(() => {
    loadNotifications();

    // Poll for new notifications every 30 seconds
    const interval = setInterval(() => {
      if (token && email) {
        dispatch(fetchUnreadCount({ token, email }));
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [loadNotifications, dispatch, token, email]);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    loadNotifications();
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleNotificationClick = async (notification: PersistentNotification) => {
    // Mark as read
    if (!notification.read) {
      await dispatch(markNotificationsRead({ token, email, notificationIds: [notification.id] }));
    }

    // Navigate based on notification type
    if (notification.type === 'NEW_REQUEST') {
      navigate('/admin-access');
    } else if (notification.type === 'ACCESS_APPROVED' || notification.type === 'ACCESS_REJECTED') {
      navigate('/access-requests');
    }

    handleClose();
  };

  const handleMarkAllRead = async () => {
    await dispatch(markAllNotificationsRead({ token, email }));
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const open = Boolean(anchorEl);

  return (
    <>
      <IconButton
        onClick={handleClick}
        sx={{
          color: '#5F6368',
          '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.04)' },
        }}
      >
        <Badge
          badgeContent={unreadCount}
          color="error"
          max={99}
          sx={{
            '& .MuiBadge-badge': {
              fontSize: '0.65rem',
              height: '18px',
              minWidth: '18px',
            },
          }}
        >
          <NotificationsIcon />
        </Badge>
      </IconButton>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        PaperProps={{
          sx: {
            width: 360,
            maxHeight: 480,
            borderRadius: '12px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
          },
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 1.5,
            borderBottom: '1px solid #DADCE0',
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Notifications
          </Typography>
          {unreadCount > 0 && (
            <Button
              size="small"
              onClick={handleMarkAllRead}
              sx={{ textTransform: 'none', fontSize: '0.75rem' }}
            >
              Mark all read
            </Button>
          )}
        </Box>

        {/* Content */}
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : notifications.length === 0 ? (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <NotificationsIcon sx={{ fontSize: 48, color: '#DADCE0', mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              No notifications
            </Typography>
          </Box>
        ) : (
          <List sx={{ py: 0, maxHeight: 380, overflow: 'auto' }}>
            {notifications.map((notification, index) => (
              <Box key={notification.id}>
                <ListItem
                  onClick={() => handleNotificationClick(notification)}
                  sx={{
                    cursor: 'pointer',
                    backgroundColor: notification.read ? 'transparent' : 'rgba(14, 77, 202, 0.04)',
                    '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.04)' },
                    py: 1.5,
                    px: 2,
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    {NOTIFICATION_ICONS[notification.type] || <NotificationsIcon color="action" />}
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: notification.read ? 400 : 600,
                          color: '#1F1F1F',
                          lineHeight: 1.3,
                        }}
                      >
                        {notification.title}
                      </Typography>
                    }
                    secondary={
                      <Box>
                        <Typography
                          variant="caption"
                          sx={{
                            color: '#575757',
                            display: 'block',
                            mt: 0.5,
                            lineHeight: 1.3,
                          }}
                        >
                          {notification.message}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{ color: '#9AA0A6', fontSize: '0.7rem', mt: 0.5 }}
                        >
                          {formatTime(notification.createdAt)}
                        </Typography>
                      </Box>
                    }
                  />
                  {!notification.read && (
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: '#0E4DCA',
                        ml: 1,
                      }}
                    />
                  )}
                </ListItem>
                {index < notifications.length - 1 && <Divider />}
              </Box>
            ))}
          </List>
        )}

        {/* Footer */}
        {notifications.length > 0 && (
          <Box
            sx={{
              borderTop: '1px solid #DADCE0',
              py: 1,
              textAlign: 'center',
            }}
          >
            <Button
              size="small"
              onClick={() => {
                navigate('/admin-access');
                handleClose();
              }}
              sx={{ textTransform: 'none' }}
            >
              View all in Access Management
            </Button>
          </Box>
        )}
      </Popover>
    </>
  );
};

export default NotificationCenter;
