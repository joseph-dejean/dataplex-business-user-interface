import React, { useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions,
    Button, TextField, Box, Typography, Alert,
    FormControl, InputLabel, Select, MenuItem,
    CircularProgress, Stepper, Step, StepLabel
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import axios from 'axios';
import { URLS } from '../../constants/urls';

interface CreateDataProductDialogProps {
    open: boolean;
    onClose: () => void;
    onCreated: (dataProduct: any) => void;
    userToken: string;
}

const REGIONS = [
    { value: 'europe-west1', label: 'Europe West 1 (Belgium)' },
    { value: 'europe-west2', label: 'Europe West 2 (London)' },
    { value: 'europe-west3', label: 'Europe West 3 (Frankfurt)' },
    { value: 'us-central1', label: 'US Central 1 (Iowa)' },
    { value: 'us-east1', label: 'US East 1 (South Carolina)' },
    { value: 'us-west1', label: 'US West 1 (Oregon)' },
    { value: 'asia-east1', label: 'Asia East 1 (Taiwan)' },
    { value: 'asia-northeast1', label: 'Asia Northeast 1 (Tokyo)' },
];

const CreateDataProductDialog: React.FC<CreateDataProductDialogProps> = ({
    open,
    onClose,
    onCreated,
    userToken
}) => {
    const [activeStep, setActiveStep] = useState(0);
    const [displayName, setDisplayName] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('europe-west1');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdDataProduct, setCreatedDataProduct] = useState<any>(null);

    const steps = ['Data Product Details', 'Add Assets (Optional)'];

    const handleCreate = async () => {
        if (!displayName.trim()) {
            setError('Display name is required');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await axios.post(
                `${URLS.API_URL}${URLS.CREATE_DATA_PRODUCT}`,
                {
                    displayName: displayName.trim(),
                    description: description.trim(),
                    location
                },
                {
                    headers: { Authorization: `Bearer ${userToken}` }
                }
            );

            if (response.data.success) {
                setCreatedDataProduct(response.data.dataProduct);
                setActiveStep(1); // Move to add assets step
            } else {
                setError(response.data.message || 'Failed to create data product');
            }
        } catch (err: any) {
            console.error('Error creating data product:', err);
            setError(err.response?.data?.message || err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    const handleFinish = () => {
        onCreated(createdDataProduct);
        handleClose();
    };

    const handleClose = () => {
        setActiveStep(0);
        setDisplayName('');
        setDescription('');
        setLocation('europe-west1');
        setError(null);
        setCreatedDataProduct(null);
        onClose();
    };

    return (
        <Dialog
            open={open}
            onClose={handleClose}
            maxWidth="sm"
            fullWidth
            PaperProps={{
                sx: { borderRadius: '16px' }
            }}
        >
            <DialogTitle sx={{ fontFamily: '"Google Sans", sans-serif', fontWeight: 500 }}>
                Create Data Product
            </DialogTitle>

            <DialogContent>
                <Stepper activeStep={activeStep} sx={{ mb: 3, mt: 1 }}>
                    {steps.map((label) => (
                        <Step key={label}>
                            <StepLabel>{label}</StepLabel>
                        </Step>
                    ))}
                </Stepper>

                {error && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                        {error}
                    </Alert>
                )}

                {activeStep === 0 && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <TextField
                            label="Display Name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            fullWidth
                            required
                            placeholder="e.g., Customer Analytics"
                            disabled={loading}
                        />

                        <TextField
                            label="Description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            fullWidth
                            multiline
                            rows={3}
                            placeholder="Describe what this data product contains..."
                            disabled={loading}
                        />

                        <FormControl fullWidth>
                            <InputLabel>Region</InputLabel>
                            <Select
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                label="Region"
                                disabled={loading}
                            >
                                {REGIONS.map((region) => (
                                    <MenuItem key={region.value} value={region.value}>
                                        {region.label}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>

                        <Alert severity="info" sx={{ mt: 1 }}>
                            <Typography variant="body2">
                                <strong>Important:</strong> Assets added to this data product must be in the same region (<strong>{location}</strong>).
                                Choose your region carefully based on where your data resides.
                            </Typography>
                        </Alert>
                    </Box>
                )}

                {activeStep === 1 && createdDataProduct && (
                    <Box sx={{ textAlign: 'center', py: 2 }}>
                        <Alert severity="success" sx={{ mb: 3 }}>
                            Data Product "{displayName}" created successfully in <strong>{location}</strong>!
                        </Alert>

                        <Typography variant="body1" sx={{ mb: 2, color: '#575757' }}>
                            You can now add assets to your data product from the Data Products detail page.
                        </Typography>

                        <Typography variant="body2" sx={{ color: '#9AA0A6' }}>
                            Remember: Only assets from <strong>{location}</strong> can be added to this data product.
                        </Typography>
                    </Box>
                )}
            </DialogContent>

            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={handleClose} disabled={loading}>
                    Cancel
                </Button>

                {activeStep === 0 && (
                    <Button
                        variant="contained"
                        onClick={handleCreate}
                        disabled={loading || !displayName.trim()}
                        startIcon={loading ? <CircularProgress size={16} /> : <AddIcon />}
                        sx={{ backgroundColor: '#0E4DCA' }}
                    >
                        {loading ? 'Creating...' : 'Create Data Product'}
                    </Button>
                )}

                {activeStep === 1 && (
                    <Button
                        variant="contained"
                        onClick={handleFinish}
                        sx={{ backgroundColor: '#0E4DCA' }}
                    >
                        Done
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
};

export default CreateDataProductDialog;
