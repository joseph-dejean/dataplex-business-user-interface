import React, { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  CircularProgress,
  Chip,
  Grid,
  Divider,
  Tooltip,
  IconButton,
  Collapse,
  Paper
} from '@mui/material';
import {
  Storage,
  TableRows,
  Schedule,
  ViewColumn,
  CheckCircle,
  Error as ErrorIcon,
  ContentCopy,
  ExpandMore,
  ExpandLess,
  Code,
  Description
} from '@mui/icons-material';
import { Highlight, themes } from 'prism-react-renderer';
import api from '../../api/api';

interface InsightsPanelProps {
  entryName?: string;
  fullyQualifiedName?: string;
}

interface TableMetadata {
  numRows: number | null;
  numBytes: number | null;
  numBytesFormatted: string;
  creationTime: string | null;
  lastModifiedTime: string | null;
  location: string;
  tableType: string;
  numColumns: number;
  partitioning: { type: string; field: string } | null;
  clustering: string[] | null;
}

interface SuggestedQuery {
  title: string;
  description: string;
  query: string;
}

interface InsightsData {
  tableMetadata: TableMetadata | null;
  description: string | null;
  suggestedQueries: SuggestedQuery[];
  dataProfile: any | null;
  dataQuality: any | null;
  aspects: Record<string, any>;
  source: string[];
}

const InsightsPanel: React.FC<InsightsPanelProps> = ({ entryName, fullyQualifiedName }) => {
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    const fetchInsights = async () => {
      if (!entryName && !fullyQualifiedName) return;

      setLoading(true);
      setError(null);

      try {
        const response = await api.post('/get-insights', {
          entryName,
          fullyQualifiedName
        });
        setInsights(response.data);
      } catch (err: any) {
        console.error('Failed to fetch insights:', err);
        setError(err.message || 'Failed to load insights');
      } finally {
        setLoading(false);
      }
    };

    fetchInsights();
  }, [entryName, fullyQualifiedName]);

  const handleCopyQuery = async (query: string, index: number) => {
    try {
      await navigator.clipboard.writeText(query);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (loading) {
    return (
      <Card sx={{ mb: 2, borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <CardContent sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 4 }}>
          <CircularProgress size={24} sx={{ mr: 2 }} />
          <Typography color="text.secondary">Loading insights...</Typography>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card sx={{ mb: 2, borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
        <CardContent>
          <Typography color="error" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ErrorIcon fontSize="small" />
            {error}
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (!insights || (!insights.tableMetadata && !insights.dataProfile && !insights.dataQuality && !insights.description)) {
    return null;
  }

  const formatNumber = (num: number | null): string => {
    if (num === null) return 'N/A';
    return num.toLocaleString();
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <Card sx={{ mb: 2, borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
      <CardContent>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, color: '#1f1f1f', fontSize: '1rem' }}>
            Table Insights
          </Typography>
          {insights.source.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {insights.source.map((src, idx) => (
                <Chip
                  key={idx}
                  label={src}
                  size="small"
                  sx={{
                    fontSize: '0.7rem',
                    height: '20px',
                    backgroundColor: '#e8f0fe',
                    color: '#1967d2'
                  }}
                />
              ))}
            </Box>
          )}
        </Box>

        {/* Table Description */}
        {insights.description && (
          <Box sx={{ mb: 2, p: 1.5, backgroundColor: '#f8f9fa', borderRadius: '8px', borderLeft: '3px solid #1967d2' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <Description sx={{ color: '#5f6368', fontSize: '1.1rem', mt: 0.2 }} />
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 500 }}>
                  Description
                </Typography>
                <Typography variant="body2" sx={{ color: '#3c4043', lineHeight: 1.5 }}>
                  {insights.description}
                </Typography>
              </Box>
            </Box>
          </Box>
        )}

        {/* Table Metadata Grid */}
        {insights.tableMetadata && (
          <Grid container spacing={2}>
            {/* Row Count */}
            <Grid size={{ xs: 6, sm: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <TableRows sx={{ color: '#5f6368', fontSize: '1.2rem' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Rows
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {formatNumber(insights.tableMetadata.numRows)}
                  </Typography>
                </Box>
              </Box>
            </Grid>

            {/* Size */}
            <Grid size={{ xs: 6, sm: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Storage sx={{ color: '#5f6368', fontSize: '1.2rem' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Size
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {insights.tableMetadata.numBytesFormatted}
                  </Typography>
                </Box>
              </Box>
            </Grid>

            {/* Columns */}
            <Grid size={{ xs: 6, sm: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <ViewColumn sx={{ color: '#5f6368', fontSize: '1.2rem' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Columns
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {insights.tableMetadata.numColumns}
                  </Typography>
                </Box>
              </Box>
            </Grid>

            {/* Last Modified */}
            <Grid size={{ xs: 6, sm: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Schedule sx={{ color: '#5f6368', fontSize: '1.2rem' }} />
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Last Modified
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.75rem' }}>
                    {formatDate(insights.tableMetadata.lastModifiedTime)}
                  </Typography>
                </Box>
              </Box>
            </Grid>

            {/* Additional Info Row */}
            {(insights.tableMetadata.partitioning || insights.tableMetadata.clustering) && (
              <>
                <Grid size={12}>
                  <Divider sx={{ my: 1 }} />
                </Grid>
                {insights.tableMetadata.partitioning && (
                  <Grid size={6}>
                    <Tooltip title="Table is partitioned for better query performance">
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <CheckCircle sx={{ color: '#34a853', fontSize: '1rem' }} />
                        <Typography variant="caption" color="text.secondary">
                          Partitioned by {insights.tableMetadata.partitioning.field} ({insights.tableMetadata.partitioning.type})
                        </Typography>
                      </Box>
                    </Tooltip>
                  </Grid>
                )}
                {insights.tableMetadata.clustering && (
                  <Grid size={6}>
                    <Tooltip title="Table is clustered for better query performance">
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <CheckCircle sx={{ color: '#34a853', fontSize: '1rem' }} />
                        <Typography variant="caption" color="text.secondary">
                          Clustered by {insights.tableMetadata.clustering.join(', ')}
                        </Typography>
                      </Box>
                    </Tooltip>
                  </Grid>
                )}
              </>
            )}
          </Grid>
        )}

        {/* Suggested Queries */}
        {insights.suggestedQueries && insights.suggestedQueries.length > 0 && (
          <>
            <Divider sx={{ my: 2 }} />
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <Code sx={{ color: '#1967d2', fontSize: '1.2rem' }} />
                <Typography variant="subtitle2" sx={{ fontWeight: 600, color: '#1f1f1f' }}>
                  Suggested Queries
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {insights.suggestedQueries.map((sq, index) => (
                  <Paper
                    key={index}
                    elevation={0}
                    sx={{
                      border: '1px solid #e0e0e0',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      '&:hover': { borderColor: '#1967d2' }
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        px: 1.5,
                        py: 1,
                        cursor: 'pointer',
                        backgroundColor: expandedQuery === index ? '#f8f9fa' : 'transparent',
                        '&:hover': { backgroundColor: '#f8f9fa' }
                      }}
                      onClick={() => setExpandedQuery(expandedQuery === index ? null : index)}
                    >
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 500, color: '#1f1f1f' }}>
                          {sq.title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {sq.description}
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Tooltip title={copiedIndex === index ? 'Copied!' : 'Copy query'}>
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyQuery(sq.query, index);
                            }}
                            sx={{ color: copiedIndex === index ? '#34a853' : '#5f6368' }}
                          >
                            <ContentCopy sx={{ fontSize: '1rem' }} />
                          </IconButton>
                        </Tooltip>
                        {expandedQuery === index ? (
                          <ExpandLess sx={{ color: '#5f6368' }} />
                        ) : (
                          <ExpandMore sx={{ color: '#5f6368' }} />
                        )}
                      </Box>
                    </Box>
                    <Collapse in={expandedQuery === index}>
                      <Highlight theme={themes.nightOwlLight} code={sq.query || ''} language="sql">
                        {({ className, style, tokens, getLineProps, getTokenProps }) => (
                          <Box
                            component="pre"
                            className={className}
                            sx={{
                              ...style,
                              px: 1.5,
                              py: 1,
                              margin: 0,
                              fontSize: '0.8rem',
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              overflowX: 'auto'
                            }}
                          >
                            {tokens.map((line, i) => (
                              <div {...getLineProps({ line, key: i })}>
                                {line.map((token, key) => (
                                  <span {...getTokenProps({ token, key })} />
                                ))}
                              </div>
                            ))}
                          </Box>
                        )}
                      </Highlight>
                    </Collapse>
                  </Paper>
                ))}
              </Box>
            </Box>
          </>
        )}

        {/* Data Profile (Dataplex Data Profile scan) */}
        {insights.dataProfile && (
          <>
            <Divider sx={{ my: 2 }} />
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                <ViewColumn sx={{ color: '#1967d2', fontSize: '1.2rem' }} />
                <Typography variant="subtitle2" sx={{ fontWeight: 600, color: '#1f1f1f' }}>
                  Data Profile
                </Typography>
                {insights.dataProfile.rowCount != null && (
                  <Typography variant="caption" color="text.secondary">
                    ({formatNumber(Number(insights.dataProfile.rowCount))} rows scanned)
                  </Typography>
                )}
              </Box>
              {Array.isArray(insights.dataProfile.profile?.fields) && insights.dataProfile.profile.fields.length > 0 ? (
                <Box sx={{ overflowX: 'auto' }}>
                  <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                    <Box component="thead">
                      <Box component="tr" sx={{ textAlign: 'left', color: '#5f6368' }}>
                        <Box component="th" sx={{ py: 0.5, pr: 1, fontWeight: 500 }}>Column</Box>
                        <Box component="th" sx={{ py: 0.5, pr: 1, fontWeight: 500 }}>Type</Box>
                        <Box component="th" sx={{ py: 0.5, pr: 1, fontWeight: 500 }}>Null %</Box>
                        <Box component="th" sx={{ py: 0.5, pr: 1, fontWeight: 500 }}>Distinct %</Box>
                      </Box>
                    </Box>
                    <Box component="tbody">
                      {insights.dataProfile.profile.fields.slice(0, 50).map((field: any, i: number) => {
                        const p = field.profile || {};
                        const ratioCell = (v: any, color: string) => {
                          if (v == null) return <Typography variant="caption" color="text.secondary">—</Typography>;
                          const ratio = Math.max(0, Math.min(1, Number(v)));
                          return (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 90 }}>
                              <Box sx={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: '#eef1f5', overflow: 'hidden' }}>
                                <Box sx={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: color }} />
                              </Box>
                              <Typography variant="caption" sx={{ color: '#3c4043', minWidth: 30, textAlign: 'right' }}>
                                {Math.round(ratio * 100)}%
                              </Typography>
                            </Box>
                          );
                        };
                        return (
                          <Box component="tr" key={field.name || i} sx={{ borderTop: '1px solid #eee' }}>
                            <Box component="td" sx={{ py: 0.5, pr: 1, fontWeight: 500, color: '#1f1f1f' }}>{field.name}</Box>
                            <Box component="td" sx={{ py: 0.5, pr: 1, color: '#5f6368' }}>{field.type}</Box>
                            <Box component="td" sx={{ py: 0.5, pr: 1 }}>{ratioCell(p.nullRatio, '#ea8600')}</Box>
                            <Box component="td" sx={{ py: 0.5, pr: 1 }}>{ratioCell(p.distinctRatio, '#1a73e8')}</Box>
                          </Box>
                        );
                      })}
                    </Box>
                  </Box>
                </Box>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Profile available from Dataplex Data Profile scan.
                </Typography>
              )}
            </Box>
          </>
        )}

        {/* Data Quality Score */}
        {insights.dataQuality && (
          <>
            <Divider sx={{ my: 2 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: insights.dataQuality.passed ? '#e6f4ea' : '#fce8e6',
                color: insights.dataQuality.passed ? '#34a853' : '#ea4335'
              }}>
                {insights.dataQuality.passed ? (
                  <CheckCircle sx={{ fontSize: '1.5rem' }} />
                ) : (
                  <ErrorIcon sx={{ fontSize: '1.5rem' }} />
                )}
              </Box>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Data Quality: {insights.dataQuality.score ? `${Math.round(insights.dataQuality.score * 100)}%` : (insights.dataQuality.passed ? 'Passed' : 'Failed')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  From Dataplex Data Quality Scan
                </Typography>
              </Box>
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default InsightsPanel;
