// server.js - Simple ADP backend for Render
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your frontend
app.use(cors({
  origin: [
    'https://squelab.github.io',
    'https://fantasyranker-player-data-api.onrender.com',
    'http://localhost:3000', // for local testing
    'file://' // for local HTML files
  ]
}));app.use(express.json());

// Cache for ADP data
let cachedData = {
    'PPR': null,
    'Half PPR': null,
    'Standard': null,
    'Superflex': null
};
let lastFetchTime = {};
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// FantasyPros URLs
const endpoints = {
    'PPR': 'https://www.fantasypros.com/nfl/adp/ppr-overall.php',
    'Half PPR': 'https://www.fantasypros.com/nfl/adp/half-point-ppr-overall.php',
    'Standard': 'https://www.fantasypros.com/nfl/adp/overall.php',
    'Superflex': 'https://www.fantasypros.com/nfl/adp/superflex-overall.php'
};

// Parse FantasyPros HTML to extract player data
// Improved parser - replace the existing parsePlayersFromHtml function with this
function parsePlayersFromHtml(html) {
    const $ = cheerio.load(html);
    const players = [];
    
    console.log('Attempting to parse HTML...');
    
    // Method 1: Look for data in script tags (sometimes data is in JSON)
    $('script').each((index, script) => {
        const scriptContent = $(script).html();
        if (scriptContent && scriptContent.includes('player') && scriptContent.includes('adp')) {
            console.log('Found potential player data in script tag');
            // Try to extract JSON data
            const jsonMatch = scriptContent.match(/var\s+\w+\s*=\s*(\[.*?\]);/);
            if (jsonMatch) {
                try {
                    const data = JSON.parse(jsonMatch[1]);
                    console.log('Successfully parsed JSON data:', data.length, 'items');
                    // Process this data if it looks like player data
                    return false; // Break the loop
                } catch (e) {
                    // Continue looking
                }
            }
        }
    });
    
    // Method 2: Look for table with different selectors
    const tables = $('table');
    console.log(`Found ${tables.length} tables`);
    
    tables.each((tableIndex, table) => {
        const $table = $(table);
        const rows = $table.find('tr');
        console.log(`Table ${tableIndex + 1} has ${rows.length} rows`);
        
        rows.each((rowIndex, row) => {
            const $row = $(row);
            const cells = $row.find('td, th');
            
            if (cells.length >= 4) {
                const cellTexts = [];
                cells.each((cellIndex, cell) => {
                    cellTexts.push($(cell).text().trim());
                });
                
                // Look for rows that look like player data
                const firstCell = cellTexts[0];
                const secondCell = cellTexts[1];
                const thirdCell = cellTexts[2];
                const fourthCell = cellTexts[3];
                
                // Check if this looks like a player row
                const rank = parseInt(firstCell);
                const adp = parseFloat(fourthCell);
                
                if (!isNaN(rank) && rank > 0 && rank < 500 && !isNaN(adp) && adp > 0) {
                    // This looks like a player row
                    console.log(`Found potential player row: ${cellTexts.join(' | ')}`);
                    
                    // Try to extract player info
                    const playerText = secondCell;
                    const positionText = thirdCell;
                    
                    // Look for player name and team pattern
                    const nameTeamMatch = playerText.match(/^(.+?)\s+([A-Z]{2,4})(?:\s*\(\d+\))?$/);
                    if (nameTeamMatch) {
                        const [, name, team] = nameTeamMatch;
                        
                        // Look for position pattern
                        const posMatch = positionText.match(/^([A-Z]+)(\d+)$/);
                        if (posMatch) {
                            const [, position, positionRank] = posMatch;
                            
                            players.push({
                                id: `adp_${rank}`,
                                name: name.trim(),
                                team: team.trim(),
                                position: position,
                                overallRank: rank,
                                positionRank: parseInt(positionRank),
                                adp: adp,
                                risk: 'Medium',
                                notes: ''
                            });
                            
                            console.log(`Added player: ${name} (${position}${positionRank}) - ${team}`);
                        }
                    }
                }
            }
        });
    });
    
    // Method 3: Look for divs or other elements with player data
    if (players.length === 0) {
        console.log('No players found in tables, trying alternative selectors...');
        
        // Look for any element containing what looks like player data
        const possiblePlayerElements = $('*').filter(function() {
            const text = $(this).text();
            return text.match(/\b\d+\b.*\b[A-Z]{2,3}\b.*\b\d+\.\d+\b/);
        });
        
        console.log(`Found ${possiblePlayerElements.length} elements with potential player data`);
        
        possiblePlayerElements.each((index, element) => {
            if (index < 5) { // Log first 5 for debugging
                console.log(`Potential player element ${index + 1}: ${$(element).text().trim().substring(0, 100)}`);
            }
        });
    }
    
    console.log(`Total players parsed: ${players.length}`);
    return players;
}

// Fetch ADP data for a specific scoring format
async function fetchAdpData(format) {
    const url = endpoints[format];
    if (!url) {
        throw new Error(`Unsupported format: ${format}`);
    }
    
    try {
        console.log(`Fetching ${format} data from FantasyPros...`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const players = parsePlayersFromHtml(response.data);
        
        if (players.length === 0) {
            throw new Error('No players found in response');
        }
        
        console.log(`Successfully parsed ${players.length} players for ${format}`);
        return players;
        
    } catch (error) {
        console.error(`Error fetching ${format} data:`, error.message);
        throw error;
    }
}

// Get cached data or fetch fresh if needed
async function getAdpData(format) {
    const now = Date.now();
    const lastFetch = lastFetchTime[format] || 0;
    
    // Return cached data if still fresh
    if (cachedData[format] && (now - lastFetch) < CACHE_DURATION) {
        console.log(`Returning cached ${format} data`);
        return cachedData[format];
    }
    
    // Fetch fresh data
    try {
        const players = await fetchAdpData(format);
        cachedData[format] = players;
        lastFetchTime[format] = now;
        return players;
    } catch (error) {
        // If fetch fails, return cached data if available
        if (cachedData[format]) {
            console.log(`Fetch failed, returning stale ${format} data`);
            return cachedData[format];
        }
        throw error;
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Fantasy Football ADP API',
        endpoints: {
            '/api/players/:format': 'Get ADP data for scoring format (PPR, Half PPR, Standard, Superflex)',
            '/api/players': 'Get ADP data (defaults to Half PPR)'
        },
        status: 'running'
    });
});

// Get players for specific format
app.get('/api/players/:format', async (req, res) => {
    const format = req.params.format;
    
    // Normalize format name
    const normalizedFormat = format.toLowerCase().replace(/[^a-z]/g, '');
    let actualFormat;
    
    switch (normalizedFormat) {
        case 'ppr':
            actualFormat = 'PPR';
            break;
        case 'halfppr':
        case 'half':
            actualFormat = 'Half PPR';
            break;
        case 'standard':
        case 'std':
            actualFormat = 'Standard';
            break;
        case 'superflex':
        case 'sf':
            actualFormat = 'Superflex';
            break;
        default:
            return res.status(400).json({
                error: 'Invalid format',
                supportedFormats: ['PPR', 'Half PPR', 'Standard', 'Superflex']
            });
    }
    
    try {
        const players = await getAdpData(actualFormat);
        res.json({
            format: actualFormat,
            players: players,
            lastUpdated: new Date(lastFetchTime[actualFormat]).toISOString(),
            count: players.length
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch ADP data',
            message: error.message
        });
    }
});

// Default endpoint (Half PPR)
app.get('/api/players', async (req, res) => {
    try {
        const players = await getAdpData('Half PPR');
        res.json({
            format: 'Half PPR',
            players: players,
            lastUpdated: new Date(lastFetchTime['Half PPR']).toISOString(),
            count: players.length
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch ADP data',
            message: error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cacheStatus: Object.keys(cachedData).reduce((acc, format) => {
            acc[format] = {
                cached: !!cachedData[format],
                lastFetch: lastFetchTime[format] ? new Date(lastFetchTime[format]).toISOString() : null,
                playerCount: cachedData[format] ? cachedData[format].length : 0
            };
            return acc;
        }, {})
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Fantasy ADP API running on port ${PORT}`);
    
    // Pre-load Half PPR data on startup
    getAdpData('Half PPR').catch(console.error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});