import React, { useEffect, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Skeleton,
  Button,
  Alert
} from '@mui/material';
import { LockOutlined } from '@mui/icons-material';
import { useSelector } from 'react-redux';
import DataProductAssets from './DataProductAssets';
import { useAuth } from '../../auth/AuthProvider';
import axios from 'axios';

/**
 * @file DetailPageOverview.tsx
 * @summary Renders the "Overview" tab content for the data entry detail page.
 *
 * @description
 * This component displays a detailed overview of a specific data entry.
 * It's structured using a `Grid` layout with a main left panel (9 columns)
 * and a right sidebar (3 columns).
 *
 * **Left Panel:**
 * - **Details Accordion**: Shows key metadata like description, system, status,
 * location, and copyable identifiers (Resource, FQN).
 * - **Table Info Accordion** (Conditional): Rendered only if the entry is a
 * table (`getEntryType(entry.name, '/') == 'Tables'`). Contains tabs for:
 * - **Schema**: Displays the table schema using the `Schema` component,
 * with filtering provided by `SchemaFilter`.
 * - **Sample Data**: Displays sample rows (if `sampleTableData` is provided)
 * using `TableView`, with filtering provided by `TableFilter`. Handles
 * data structure validation and potential errors during rendering.
 * - **Documentation Accordion**: Renders documentation content (potentially HTML)
 * from the entry's overview aspect.
 *
 * **Right Sidebar:**
 * - **Contacts Accordion**: Lists associated contacts with roles, using the
 * `Avatar` component.
 * - **Info Accordion**: Displays creation and last modification timestamps.
 * - **Usage Metrics Accordion**: Shows metrics like Execution Time, Total Queries,
 * and Refresh Time, extracted from the entry's usage aspect.
 * - **Labels Accordion**: Displays key-value labels associated with the entry
 * as styled chips (grid layout).
 *
 * The component uses several helper components (`Schema`, `TableView`, `Avatar`,
 * `SchemaFilter`, `TableFilter`) and utility functions (`getFormattedDateTimeParts`,
 * `getEntryType`, `hasData`). It also includes a recursive `FieldRenderer` to
 * display various data types (string, number, list, struct) appropriately.
 * It leverages the `useNotification` hook to provide feedback when identifiers
 * are copied to the clipboard.
 * Accordions are conditionally expanded by default based on whether they contain
 * data (`hasData` helper).
 *
 * @param {object} props - The props for the DetailPageOverview component.
 * @param {any} props.entry - The main data entry object containing all details,
 * aspects (schema, contacts, usage, overview), and metadata.
 * @param {any} [props.sampleTableData] - Optional. An array of sample row data,
 * typically used when the entry is a table.
 * @param {React.CSSProperties} props.css - Optional CSS properties to apply
 * to the root `div` container.
 *
 * @returns {JSX.Element} The rendered React component for the Overview tab.
 */

const StringRenderer = ({ value }: any) => {
  // Check if the string contains HTML tags
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(value);
  if (isHtml) {
    // If it's HTML, render it directly. CAUTION: This can be a security risk (XSS) if the HTML is from an untrusted source.
    return <div dangerouslySetInnerHTML={{ __html: value }} />;
  }
  return <span style={{ fontSize: "14px", textTransform: "capitalize", padding: "0px 5px" }}>{value}</span>;
};

const NumberRenderer = ({ value }: any) => {
  return <span style={{ fontSize: "14px" }}>{value}</span>;
};

const BooleanRenderer = ({ value }: any) => {
  return value ?
    <span style={{ fontSize: "14px" }}>TRUE</span> :
    <span style={{ fontSize: "14px" }}>FALSE</span>;
};

const ListRenderer = ({ values }: any) => {
  return (<>
    {values.map((item: any) => (
      <FieldRenderer field={item} />
    ))}
  </>);
};

const StructRenderer = ({ fields }: any) => {
  return (
    <Box style={{ paddingTop: "10px" }}>
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <span style={{ fontWeight: "600", fontSize: "12px", textTransform: "capitalize" }}>{key.replace(/_/g, ' ')}:</span>
          <FieldRenderer field={value} />
        </div>
      ))}
      <br />
    </Box>
  );
};

// --- The Main Field Renderer (Component) ---

const FieldRenderer = ({ field }: any) => {
  if (!field || !field.kind) {
    return <span style={{ fontSize: "14px" }}>-</span>;
  }

  switch (field.kind) {
    case 'stringValue':
      return <StringRenderer value={field.stringValue} />;
    case 'numberValue':
      return <NumberRenderer value={field.numberValue} />;
    case 'boolValue':
      return <BooleanRenderer value={field.boolValue} />;
    case 'listValue':
      return <ListRenderer values={field.listValue.values} />;
    case 'structValue':
      return <StructRenderer fields={field.structValue.fields} />;
    default:
      return <span style={{ fontWeight: "500", fontSize: "14px" }}>Unknown kind: {field.kind}</span>;
  }
};

// //interface for the component props
interface AssetsProps {
  entry: any;
  css?: React.CSSProperties; // Optional CSS properties for the button
  onAssetPreviewChange?: (data: any) => void;
  onRequestAccess?: (assetInfo: any) => void;
}

// Tab component
const Assets: React.FC<AssetsProps> = ({ entry, css, onAssetPreviewChange, onRequestAccess }) => {


  //const dispatch = useDispatch<AppDispatch>();
  const { dataProductAssets, dataProductAssetsStatus } = useSelector((state: any) => state.dataProducts);
  const [dataProductsAssetsList, setDataProductsAssetsList] = useState([]);
  const [assetListLoader, setAssetListLoader] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const { user } = useAuth();
  const id_token = user?.token;
  // const [assetPreviewData, setAssetPreviewData] = useState<any | null>(null);
  // const [isAssetPreviewOpen, setIsAssetPreviewOpen] = useState(false);


  const number = entry?.entryType?.split('/')[1];

  /**
   * Build fallback asset entries from raw dataProductAssets when searchEntries fails (e.g., no access).
   * This allows users to see which assets exist and request access to them.
   */
  const buildFallbackAssets = (rawAssets: any[]) => {
    return rawAssets
      .filter((item: any) => item.resource)
      .map((item: any) => {
        const resource = item.resource;
        // Extract a human-readable name from the resource path
        // e.g., //bigquery.googleapis.com/projects/proj/datasets/ds/tables/tbl -> ds.tbl
        const projectsPart = resource.split('projects/')[1];
        if (!projectsPart) return null;

        const parts = projectsPart.split('/');
        let displayName = '';
        let system = 'bigquery';
        let entryType = 'TABLE';

        if (resource.includes('//')) {
          const svcParts = resource.split('//')[1].split('.');
          if (svcParts.length > 0 && svcParts[0] !== 'googleapis') {
            system = svcParts[0];
          }
        }

        if (parts.length >= 5) {
          // projects/{p}/datasets/{d}/tables/{t}
          displayName = `${parts[2]}.${parts[4]}`;
          entryType = parts[3] === 'tables' ? 'TABLE' : parts[3].toUpperCase();
        } else if (parts.length >= 3) {
          displayName = parts[2];
          entryType = 'DATASET';
        } else {
          displayName = parts[0];
        }

        return {
          dataplexEntry: {
            name: resource,
            entrySource: {
              displayName: displayName,
              description: item.description || '',
              system: system.toUpperCase(),
              resource: resource,
            },
            entryType: entryType,
            fullyQualifiedName: `${system}:${projectsPart.split('/').filter((_: string, i: number) => i % 2 === 1).join('.')}`,
          },
          linkedResource: resource,
          _accessDenied: true, // marker for locked state
        };
      })
      .filter(Boolean);
  };

  useEffect(() => {
    console.log('--- FRONTEND_ASSETS_VERSION: 3.3 ---');
    console.log('Assets Entry Name:', entry?.name);
    console.log('num', number);
    if (dataProductAssets.length === 0) return;
    if (dataProductAssetsStatus !== 'succeeded') return;
    if (dataProductAssetsStatus === 'succeeded' && dataProductAssets.length === 0) {
      setDataProductsAssetsList([]);
      return;
    }

    if (dataProductAssetsStatus === 'succeeded' && dataProductAssets.length > 0) {
      let a = dataProductAssets.map((item: any) => {
        if (!item.resource) return '';
        const resource = item.resource;

        // Extract system (e.g. 'bigquery') from //bigquery.googleapis.com/... or default to 'bigquery'
        let system = 'bigquery';
        if (resource.includes('//')) {
          const parts = resource.split('//')[1].split('.');
          if (parts.length > 0 && parts[0] !== 'googleapis') {
            system = parts[0];
          }
        }

        const projectsPart = resource.split('projects/')[1];
        if (!projectsPart) return '';

        const parts = projectsPart.split('/');
        // Format: project.dataset[.table]
        // parts[0]: project, parts[2]: dataset, parts[4]: table (if available)
        let p = '';
        if (parts.length >= 5) {
          p = `${parts[0]}.${parts[2]}.${parts[4]}`;
        } else if (parts.length >= 3) {
          p = `${parts[0]}.${parts[2]}`;
        } else {
          p = parts[0];
        }

        return system + ':' + p;
      }).filter(Boolean);

      if (a.length === 0) {
        setDataProductsAssetsList([]);
        setAssetListLoader(true);
        return;
      }

      // Extract project ID and location from the entry name (e.g., projects/{proj}/locations/{loc}/...)
      const entryParts = entry?.name?.split('/') || [];
      const projectIndex = entryParts.indexOf('projects');
      const locationIndex = entryParts.indexOf('locations');
      const projectId = projectIndex !== -1 ? entryParts[projectIndex + 1] : import.meta.env.VITE_GOOGLE_PROJECT_ID;
      const location = locationIndex !== -1 ? entryParts[locationIndex + 1] : 'global';

      console.log('[Assets] Using project:', projectId, 'location:', location);

      let searchTerm = 'fully_qualified_name=(' + a.join(' | ');
      searchTerm += ')';
      const requestResourceData = {
        query: searchTerm,
      }
      axios.post(
        `https://dataplex.googleapis.com/v1/projects/${projectId}/locations/${location}:searchEntries`,
        requestResourceData,
        {
          headers: {
            Authorization: `Bearer ${user?.token}`,
            'Content-Type': 'application/json',
          },
        }
      ).then((response: any) => {
        console.log('fet Ass', response.data);
        setAccessDenied(false);
        setDataProductsAssetsList(response.data.results || []);
        setAssetListLoader(true);
      }).catch((error: any) => {
        console.error('Error fetching data product assets details:', error);
        const isPermissionError = error?.response?.status === 403 || error?.response?.status === 401;
        // Try with 'global' location as fallback
        if (location !== 'global') {
          console.log('[Assets] Retrying with global location...');
          axios.post(
            `https://dataplex.googleapis.com/v1/projects/${projectId}/locations/global:searchEntries`,
            requestResourceData,
            {
              headers: {
                Authorization: `Bearer ${user?.token}`,
                'Content-Type': 'application/json',
              },
            }
          ).then((response: any) => {
            console.log('[Assets] Fallback succeeded:', response.data);
            setAccessDenied(false);
            setDataProductsAssetsList(response.data.results || []);
            setAssetListLoader(true);
          }).catch((err: any) => {
            console.error('[Assets] Fallback also failed:', err);
            // Show fallback locked assets so user can still see what's in the data product
            const fallback = buildFallbackAssets(dataProductAssets);
            if (fallback.length > 0) {
              setAccessDenied(true);
              setDataProductsAssetsList(fallback as any);
            }
            setAssetListLoader(true);
          });
        } else {
          // Show fallback locked assets
          if (isPermissionError || error?.response?.status >= 400) {
            const fallback = buildFallbackAssets(dataProductAssets);
            if (fallback.length > 0) {
              setAccessDenied(true);
              setDataProductsAssetsList(fallback as any);
            }
          }
          setAssetListLoader(true);
        }
      });
    }
  }, [dataProductAssets, entry?.name]);


  // useEffect(() => {
  //     if (entry?.name ==='projects/data-studio-459108/locations/us-central1/entryGroups/@dataplex/entries/projects/1069578231809/locations/us-central1/dataProducts/acme-shopstream-sales-performance') {
  //         setDataProductsAssetsList(acmeAssetsSampleData);
  //     }else if (entry?.name ==='projects/data-studio-459108/locations/us-central1/entryGroups/@dataplex/entries/projects/1069578231809/locations/us-central1/dataProducts/cymbal-customer-experience-and-retention') {
  //         setDataProductsAssetsList(cymbalAssetsSampleData);
  //     } else {
  //         setDataProductsAssetsList([]);
  //     }
  // }, [dataProductAssets]);

  //sorting handlers
  // const handleSortMenuClick = (event: React.MouseEvent<HTMLElement>) => {
  //     setSortAnchorEl(event.currentTarget);
  // };

  // const handleSortMenuClose = () => {
  //     setSortAnchorEl(null);
  // };

  // const handleSortOptionSelect = (option: 'name' | 'lastModified') => {
  //     setSortBy(option);
  //     //setSortOrder(prevOrder => prevOrder === 'asc' ? 'desc' : 'asc');
  //     setDataProductsAssetsList(dataProductsAssetsList);
  //     handleSortMenuClose();
  // };

  // const sortItems = (items: any[]) => {
  //     return [...items].sort((a, b) => {
  //     if (sortBy === 'name') {
  //         const nameA = a.displayName.toLowerCase();
  //         const nameB = b.displayName.toLowerCase();
  //         if (sortOrder === 'asc') return nameA.localeCompare(nameB);
  //         return nameB.localeCompare(nameA);
  //     } else {
  //         // Last Modified (Number)
  //         const dateA = a.updateTime || 0;
  //         const dateB = b.updateTime || 0;
  //         if (sortOrder === 'asc') return dateA - dateB; // Oldest first
  //         return dateB - dateA; // Newest first
  //     }
  //     });
  // };



  return (
    <div>
      <Paper
        elevation={0}
        sx={{
          flex: 1,
          borderRadius: '24px',
          backgroundColor: '#fff',
          border: 'transparent',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative'
        }}
        style={{ ...css }}
      >
        <Box
        >
          {/* <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.1, position: 'relative', top: '40px', left: '20px' }}>
                <TextField
                    size="small"
                    variant="outlined"
                    placeholder="Search data products Assets"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    sx={{
                        '& .MuiOutlinedInput-root': {
                            borderRadius: '54px',
                            height: '32px',
                            fontFamily: 'Google Sans Text',
                            fontSize: '12px',
                            fontWeight: 500,
                            letterSpacing: '0.1px',
                            marginRight: '10px',
                            color: '#5E5E5E',
                            '& fieldset': { borderColor: '#DADCE0' },
                            '&:hover fieldset': { borderColor: '#A8A8A8' },
                            '&.Mui-focused fieldset': { borderColor: '#0E4DCA', borderWidth: '1.5px' },
                        },
                        width: '350px',
                        '& .MuiInputBase-input': {
                            padding: '6px 12px',
                            '&::placeholder': {
                                color: '#5E5E5E',
                                opacity: 1,
                            },
                        },
                        boxShadow: 'none',
                    }}
                    InputProps={{
                        startAdornment: <Search sx={{ color: '#575757', fontSize: 20, mr: 1 }} />,
                    }}
                />
                <>
                    {dataProductAssetsStatus === 'succeeded' && dataProductsAssetsList.length > 0 && (() => {
              
                        return (
                            <FilterTag
                                key={`type-All`}
                                handleClick={() => {}}
                                handleClose={() => {}}
                                showCloseButton={false}
                                css={{
                                margin: "0px",
                                textTransform: "capitalize",
                                fontFamily: '"Google Sans Text", sans-serif',
                                fontWeight: 400,
                                fontSize: '12px',
                                letterSpacing: '0.83%',
                                padding: '8px 13px',
                                borderRadius: '59px',
                                gap: '8px',
                                display: 'flex',
                                alignItems: 'center',
                                backgroundColor: false ? '#E7F0FE' : 'transparent',
                                color: false ? '#0E4DCA' : '#1F1F1F',
                                border: false ? 'none' : '1px solid #DADCE0',
                                height: '32px',
                                whiteSpace: 'nowrap'
                                }}
                                text={`All ${dataProductsAssetsList.length}`}
                                />
                            )
                    })}
                    <GridFilterListIcon />
                    <Typography component="span" style={{ margin: "0px 5px", fontSize: "12px", fontWeight: "500" }}>
                        Sort by:
                    </Typography>
                    <Typography 
                    component="span" 
                    style={{ 
                        margin: "0px 5px", 
                        fontSize: "12px", 
                        fontWeight: "500", 
                        display: "flex", 
                        alignItems: "center",
                        cursor: "pointer",
                        color: "#1F1F1F"
                    }}
                    onClick={handleSortMenuClick}
                    >
                        {sortBy === 'name' ? 'Name' : 'Last Modified'} 
                        <KeyboardArrowDown style={{ marginLeft: "2px" }} />
                    </Typography>
                </>

                <Menu
                    anchorEl={sortAnchorEl}
                    open={Boolean(sortAnchorEl)}
                    onClose={() => {console.log("closing")}}
                    anchorOrigin={{
                        vertical: 'bottom',
                        horizontal: 'left',
                    }}
                    transformOrigin={{
                    vertical: 'top',
                    horizontal: 'left',
                    }}
                    PaperProps={{
                        style: {
                            marginTop: '4px',
                            borderRadius: '8px',
                            boxShadow: '0px 4px 6px -1px rgba(0, 0, 0, 0.1), 0px 2px 4px -1px rgba(0, 0, 0, 0.06)',
                            minWidth: '140px'
                        }
                    }}
                >
                    <MenuItem 
                    onClick={() =>{handleSortOptionSelect('name')}}
                    style={{
                        fontSize: '12px',
                        fontWeight: sortBy === 'name' ? '500' : '400',
                        color: sortBy === 'name' ? '#0B57D0' : '#1F1F1F',
                        backgroundColor: sortBy === 'name' ? '#F8FAFD' : 'transparent'
                    }}
                    >
                    Name
                    </MenuItem>
                    <MenuItem 
                    onClick={() => {handleSortOptionSelect('lastModified')}}
                    style={{
                        fontSize: '12px',
                        fontWeight: sortBy === 'lastModified' ? '500' : '400',
                        color: sortBy === 'lastModified' ? '#0B57D0' : '#1F1F1F',
                        backgroundColor: sortBy === 'lastModified' ? '#F8FAFD' : 'transparent'
                    }}
                    >
                    Last Modified
                    </MenuItem>
                </Menu>
                

            </Box> */}


          <Box sx={{
            display: 'flex',
            flexDirection: 'column',
            padding: ' 0px 20px',
            height: 'calc(100vh - 200px)',
            overflowY: 'auto'
          }}>
            {
              !assetListLoader && (
                <Box sx={{ marginTop: '1.25rem' }}>
                  <Skeleton variant="rectangular" width="100%" height={40} sx={{ marginBottom: '10px', borderRadius: '8px' }} />
                  <Skeleton variant="rectangular" width="100%" height={40} sx={{ marginBottom: '10px', borderRadius: '8px' }} />
                  <Skeleton variant="rectangular" width="100%" height={40} sx={{ marginBottom: '10px', borderRadius: '8px' }} />
                  <Skeleton variant="rectangular" width="100%" height={40} sx={{ marginBottom: '10px', borderRadius: '8px' }} />
                </Box>
              )
            }
            {dataProductAssetsStatus === 'loading' && (
              <Typography sx={{ fontSize: '14px', color: '#575757', marginTop: 40 }}>Loading data product assets...</Typography>
            )}
            {dataProductAssetsStatus === 'succeeded' && dataProductAssets.length === 0 && assetListLoader && (
              <Typography sx={{ fontSize: '14px', color: '#575757', marginTop: 40 }}>No data product assets found.</Typography>
            )}
            {dataProductAssetsStatus === 'succeeded' && dataProductAssets.length > 0 && assetListLoader && accessDenied && (
              /* Access denied: show locked asset list with request access buttons */
              <Box sx={{ marginTop: '1.25rem' }}>
                <Alert
                  severity="info"
                  icon={<LockOutlined />}
                  sx={{
                    mb: 2,
                    borderRadius: '12px',
                    fontFamily: '"Google Sans Text", sans-serif',
                    fontSize: '13px',
                    backgroundColor: '#E8F0FE',
                    color: '#1A73E8',
                    '& .MuiAlert-icon': { color: '#1A73E8' }
                  }}
                  action={
                    onRequestAccess && (
                      <Button
                        size="small"
                        onClick={() => onRequestAccess(entry)}
                        sx={{
                          fontFamily: '"Google Sans Text", sans-serif',
                          textTransform: 'none',
                          color: '#0E4DCA',
                          fontWeight: 600,
                          fontSize: '12px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Request Access
                      </Button>
                    )
                  }
                >
                  You don't have permission to view these assets. Request access to the data product to see full details.
                </Alert>
                {dataProductsAssetsList.map((asset: any, index: number) => {
                  const assetEntry = asset.dataplexEntry || {};
                  const displayName = assetEntry.entrySource?.displayName || assetEntry.name || 'Unknown Asset';
                  const system = assetEntry.entrySource?.system || 'BIGQUERY';
                  const fqn = assetEntry.fullyQualifiedName || '';
                  return (
                    <Box
                      key={index}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        border: '1px solid #E0E0E0',
                        marginBottom: '8px',
                        backgroundColor: '#FAFAFA',
                        opacity: 0.85,
                        '&:hover': {
                          backgroundColor: '#F0F4FF',
                          borderColor: '#C2D7FE',
                        }
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, flex: 1 }}>
                        <LockOutlined sx={{ color: '#9AA0A6', fontSize: 18 }} />
                        <Box sx={{ minWidth: 0 }}>
                          <Typography sx={{
                            fontFamily: '"Google Sans Text", sans-serif',
                            fontSize: '13px',
                            fontWeight: 500,
                            color: '#3C4043',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {displayName}
                          </Typography>
                          <Typography sx={{
                            fontFamily: '"Google Sans Text", sans-serif',
                            fontSize: '11px',
                            color: '#80868B',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {system} {fqn ? `· ${fqn}` : ''}
                          </Typography>
                        </Box>
                      </Box>
                      {onRequestAccess && (
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => onRequestAccess({
                            ...entry,
                            _requestedAsset: {
                              name: displayName,
                              resource: asset.linkedResource,
                              fqn: fqn,
                              system: system,
                            }
                          })}
                          sx={{
                            fontFamily: '"Google Sans Text", sans-serif',
                            textTransform: 'none',
                            fontSize: '11px',
                            fontWeight: 500,
                            color: '#0E4DCA',
                            borderColor: '#0E4DCA',
                            borderRadius: '100px',
                            padding: '2px 12px',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                            '&:hover': {
                              backgroundColor: '#E8F0FE',
                              borderColor: '#0E4DCA',
                            }
                          }}
                        >
                          Request Access
                        </Button>
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}
            {dataProductAssetsStatus === 'succeeded' && dataProductAssets.length > 0 && assetListLoader && !accessDenied && (
              <Box sx={{ marginTop: '1.25rem' }}>
                <DataProductAssets
                  linkedAssets={dataProductsAssetsList || []}
                  searchTerm={searchTerm}
                  onSearchTermChange={setSearchTerm}
                  idToken={id_token || ''}
                  onAssetPreviewChange={(data) => {
                    onAssetPreviewChange && onAssetPreviewChange(data);
                  }}
                />
              </Box>
            )}
          </Box>
        </Box>
      </Paper>
    </div>

  );
}

export default Assets;