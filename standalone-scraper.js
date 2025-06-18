const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;

// Get current NFL season dynamically
function getCurrentNFLSeason() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const month = now.getMonth() + 1;
  
  // NFL season runs Sept-Feb
  return month >= 8 ? currentYear : currentYear - 1;
}

function getValidationYears() {
  const currentSeason = getCurrentNFLSeason();
  return {
    lastYear: currentSeason,
    yearBeforeLast: currentSeason - 1,
    currentSeason: currentSeason
  };
}

// Generate clean URL slug from player name
function generatePlayerSlug(playerName) {
  return playerName
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

// Generate name variations to try (handle collisions + ADP position lookup)
async function generateNameVariations(playerName, position, adpPlayers) {
  const baseSlug = generatePlayerSlug(playerName);
  
  // Try to find player position from ADP data if collision expected
  let playerPosition = position;
  if (adpPlayers) {
    const adpPlayer = adpPlayers.find(p => 
      p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (adpPlayer) {
      playerPosition = adpPlayer.position;
      console.log(`🎯 Found ${playerName} in ADP data: ${playerPosition}`);
    }
  }
  
  return [
    baseSlug,                                                    // josh-allen
    `${baseSlug}-${playerPosition.toLowerCase()}`,               // josh-allen-qb  
  ];
}

// Get top 250 players from ADP API (with retry logic)
async function getTop250Players() {
  const maxRetries = 3;
  const retryDelay = 30000; // 30 seconds
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Fetching ADP data... (attempt ${attempt}/${maxRetries})`);
      const response = await axios.get('https://fantasyranker-adp-api.onrender.com/api/players', {
        timeout: 60000 // 60 second timeout
      });
      
      const apiResponse = response.data;
      
      if (!apiResponse || !apiResponse.players || !Array.isArray(apiResponse.players)) {
        throw new Error('ADP API returned unexpected data structure');
      }
      
      const adpData = apiResponse.players;
      console.log(`📊 Found ${adpData.length} total players from ADP API`);
      
      // Filter to skill positions and get top 250
      const skillPositions = ['QB', 'RB', 'WR', 'TE'];
      const skillPlayers = adpData.filter(player => 
        player && player.position && skillPositions.includes(player.position)
      ).slice(0, 250);
      
      console.log(`🎯 Filtered to ${skillPlayers.length} skill position players`);
      
      return skillPlayers.map(player => ({
        name: player.name,
        position: player.position,
        team: player.team,
        adp: player.adp || player.overallRank
      }));
      
    } catch (error) {
      if (error.response?.status === 503 && attempt < maxRetries) {
        console.log(`😴 ADP API hibernating (503), waiting ${retryDelay/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      if (attempt < maxRetries) {
        console.log(`❌ ADP API error (attempt ${attempt}): ${error.message}`);
        console.log(`⏱️  Retrying in ${retryDelay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      console.error('❌ Failed to fetch ADP data after all retries:', error.message);
      throw error;
    }
  }
}

// Define fixed table structures for each position
const TABLE_STRUCTURES = {
  QB: {
    columns: [
      'pass_cmp', 'pass_att', 'pass_pct', 'pass_yds', 'pass_ya', 'pass_td', 'pass_int', 'pass_sacks',
      'rush_att', 'rush_yds', 'rush_ya', 'rush_lg', 'rush_td', 'fum', 'fuml', 'fantasy_points'
    ],
    identifiers: ['CMP', 'ATT', 'PCT']
  },
  
  RB: {
    columns: [
      'rush_att', 'rush_yds', 'rush_ya', 'rush_lg', 'rush_td', 'rec', 'rec_tgt', 'rec_yds', 'rec_yr', 'rec_lg', 'rec_td', 'fum', 'fuml', 'fantasy_points'
    ],
    identifiers: ['ATT', 'YDS', 'Y/A', 'REC']
  },
  
  WR: {
    columns: [
      'rec', 'rec_tgt', 'rec_yds', 'rec_yr', 'rec_lg', 'rec_td', 'rush_att', 'rush_yds', 'rush_ya', 'rush_lg', 'rush_td', 'fum', 'fuml', 'fantasy_points'
    ],
    identifiers: ['REC', 'TGT', 'YDS', 'Y/R']
  }
};

// Detect position based on table headers
function detectPositionFromHeaders(headers) {
  // Check for QB identifiers
  if (headers.includes('CMP') && headers.includes('ATT') && headers.includes('PCT')) {
    return 'QB';
  }
  
  // Check for WR/TE identifiers (receiving stats first)
  if (headers.includes('REC') && headers.includes('TGT') && headers.indexOf('REC') < headers.indexOf('ATT')) {
    return 'WR';
  }
  
  // Check for RB identifiers (rushing stats first)
  if (headers.includes('ATT') && headers.includes('REC') && headers.indexOf('ATT') < headers.indexOf('REC')) {
    return 'RB';
  }
  
  // Fallback logic
  if (headers.includes('REC')) {
    return 'WR';
  }
  
  return 'RB';
}

// Parse totals cells using fixed column mapping
function parseTotalsCellsByPosition(cells, headers, playerName) {
  const position = detectPositionFromHeaders(headers);
  const structure = TABLE_STRUCTURES[position];
  
  if (!structure) {
    return { isEmpty: true, reason: 'unknown_position' };
  }
  
  const stats = {};
  let hasValidStats = false;
  
  // Find where actual data starts - skip "Totals" and empty cells
  let dataStartIndex = -1;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].toLowerCase() === 'totals') {
      dataStartIndex = i + 1;
      while (dataStartIndex < cells.length && (!cells[dataStartIndex] || cells[dataStartIndex].trim() === '')) {
        dataStartIndex++;
      }
      break;
    }
  }
  
  if (dataStartIndex === -1) {
    return { isEmpty: true, reason: 'no_data_start' };
  }
  
  // Map each cell to its corresponding stat based on position
  for (let i = 0; i < structure.columns.length && (dataStartIndex + i) < cells.length; i++) {
    const cellValue = cells[dataStartIndex + i];
    const statName = structure.columns[i];
    
    if (cellValue && cellValue !== '-' && cellValue !== '') {
      let value = parseFloat(cellValue.replace(/,/g, ''));
      
      if (!isNaN(value)) {
        stats[statName] = value;
        hasValidStats = true;
      } else if (cellValue.includes('%')) {
        value = parseFloat(cellValue.replace('%', ''));
        if (!isNaN(value)) {
          stats[statName] = value;
          hasValidStats = true;
        }
      }
    }
  }
  
  if (!hasValidStats) {
    return { isEmpty: true, reason: 'no_valid_stats' };
  }
  
  return { ...stats, detectedPosition: position };
}

// Extract totals data from the page
function extractTotalsFromPage($, playerName, year) {
  let totalsData = null;
  
  $('*').each((index, element) => {
    const $element = $(element);
    const text = $element.text().trim();
    
    if (text.toLowerCase() === 'totals') {
      const $row = $element.closest('tr');
      if ($row.length > 0) {
        const cells = [];
        $row.find('td, th').each((i, cell) => {
          cells.push($(cell).text().trim());
        });
        
        // Find table headers
        const $table = $row.closest('table');
        const headers = [];
        $table.find('thead tr th, thead tr td').each((i, header) => {
          headers.push($(header).text().trim().toUpperCase());
        });
        
        if (headers.length === 0) {
          $table.find('tr').first().find('th, td').each((i, header) => {
            headers.push($(header).text().trim().toUpperCase());
          });
        }
        
        totalsData = parseTotalsCellsByPosition(cells, headers, playerName);
        return false;
      }
    }
  });
  
  return totalsData || { isEmpty: true, reason: 'no_totals_found' };
}

// Scrape player game log for a specific year
async function scrapePlayerGameLog(playerName, position, year, adpPlayers) {
  const nameVariations = await generateNameVariations(playerName, position, adpPlayers);
  
  for (const [index, playerSlug] of nameVariations.entries()) {
    try {
      const url = `https://www.fantasypros.com/nfl/games/${playerSlug}.php?season=${year}`;
      
      console.log(`📊 ${playerName} ${year}: Trying ${playerSlug}`);
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      
      // Check for "no game data" message
      const pageText = $('body').text().toLowerCase();
      if (pageText.includes('does not have any game data') || 
          pageText.includes('no games found') ||
          pageText.includes('player not found')) {
        continue;
      }
      
      // Look for totals data
      const totalsData = extractTotalsFromPage($, playerName, year);
      
      if (totalsData && !totalsData.isEmpty) {
        const fantasyPts = totalsData.fantasy_points || 0;
        console.log(`✅ ${playerName} ${year}: ${fantasyPts} fantasy points`);
        return {
          year: year,
          urlUsed: playerSlug,
          ...totalsData,
          scraped_at: new Date().toISOString()
        };
      }
      
    } catch (error) {
      if (error.response && error.response.status === 404) {
        continue;
      }
      console.error(`❌ Error with ${playerSlug} ${year}:`, error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  return { isEmpty: true, reason: 'all_variations_failed' };
}

// Get complete historical stats for a player
async function getPlayerCompleteHistory(player, adpPlayers) {
  console.log(`\n🔍 Processing: ${player.name} (${player.position})`);
  
  const { currentSeason } = getValidationYears();
  const seasons = {};
  let consecutiveEmptyYears = 0;
  let foundAnyData = false;
  
  // Start from current season and work backwards
  for (let year = currentSeason; year >= currentSeason - 10; year--) {
    // Try ALL URL variations for this year before deciding it's empty
    const seasonData = await scrapePlayerGameLog(player.name, player.position, year, adpPlayers);
    
    if (seasonData.isEmpty) {
      consecutiveEmptyYears++;
      console.log(`📭 ${player.name} ${year}: No data (all variations tried)`);
      
      // Rookie detection: 2+ consecutive years with NO data from ANY variation
      if (consecutiveEmptyYears >= 2 && !foundAnyData) {
        console.log(`🆕 ${player.name}: 2025 rookie pattern detected (${consecutiveEmptyYears} consecutive empty years, no historical data)`);
        
        // Double-check one more year to be absolutely sure
        const finalCheckYear = year - 1;
        const finalCheck = await scrapePlayerGameLog(player.name, player.position, finalCheckYear, adpPlayers);
        
        if (!finalCheck.isEmpty) {
          console.log(`🔍 ${player.name}: Found data at ${finalCheckYear} - not a rookie, continuing search`);
          seasons[finalCheckYear] = finalCheck;
          foundAnyData = true;
          consecutiveEmptyYears = 0;
        } else {
          console.log(`✅ ${player.name}: Confirmed 2025 rookie - stopping search`);
          return {
            name: player.name,
            position: player.position,
            team: player.team,
            adp: player.adp,
            seasons: seasons,
            total_seasons: Object.keys(seasons).length,
            is_likely_rookie: true,
            scraped_at: new Date().toISOString()
          };
        }
        
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
      // For veterans/players with some data: stop if we hit 2 consecutive empty years
      if (consecutiveEmptyYears >= 2 && foundAnyData) {
        console.log(`🛑 ${player.name}: Stopping search after 2 consecutive empty years`);
        break;
      }
    } else {
      consecutiveEmptyYears = 0;
      foundAnyData = true;
      seasons[year] = seasonData;
    }
    
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  
  // Validate we found recent activity (last 2 years)
  const { lastYear, yearBeforeLast } = getValidationYears();
  const hasRecentActivity = seasons[lastYear] || seasons[yearBeforeLast];
  
  if (!hasRecentActivity && foundAnyData) {
    console.log(`❌ ${player.name}: No recent activity - possibly retired`);
    return null;
  }
  
  if (!foundAnyData) {
    console.log(`❌ ${player.name}: No data found anywhere`);
    return null;
  }
  
  return {
    name: player.name,
    position: player.position,
    team: player.team,
    adp: player.adp,
    seasons: seasons,
    total_seasons: Object.keys(seasons).length,
    is_likely_rookie: false,
    scraped_at: new Date().toISOString()
  };
}

// Main scraping function
async function scrapeAllPlayers() {
  try {
    console.log('🚀 Starting FantasyPros scraping...');
    console.log(`📅 Current NFL season: ${getCurrentNFLSeason()}`);
    
    const players = await getTop250Players();
    const batchSize = 5;
    
    console.log(`🎯 Processing ${players.length} players in batches of ${batchSize}...`);
    
    const results = {};
    const stats = { successful: 0, failed: 0, wrong_player: 0 };
    
    for (let i = 0; i < players.length; i += batchSize) {
      const batch = players.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(players.length / batchSize);
      
      console.log(`\n📦 Batch ${batchNum}/${totalBatches}: ${batch.map(p => `${p.name} (#${i + batch.indexOf(p) + 1})`).join(', ')}`);
      
      const batchPromises = batch.map(async (player) => {
        try {
          const playerData = await getPlayerCompleteHistory(player, players);
          
          if (playerData) {
            stats.successful++;
            console.log(`✅ #${i + batch.indexOf(player) + 1}: ${player.name} - ${Object.keys(playerData.seasons || {}).length} seasons`);
            return playerData;
          } else {
            stats.wrong_player++;
            console.log(`❌ #${i + batch.indexOf(player) + 1}: ${player.name} - no valid data`);
            return null;
          }
          
        } catch (error) {
          console.error(`💥 #${i + batch.indexOf(player) + 1}: ${player.name} - Error: ${error.message}`);
          stats.failed++;
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      // Store successful results
      batchResults.forEach((result, index) => {
        if (result) {
          const key = result.name.toLowerCase().replace(/[^a-z]/g, '_');
          results[key] = result;
        }
      });
      
      console.log(`📊 Batch ${batchNum} complete. Running total: ${stats.successful} successful, ${stats.failed} failed, ${stats.wrong_player} invalid`);
      
      // Delay between batches (except for last batch)
      if (i + batchSize < players.length) {
        const delay = 4000;
        console.log(`⏱️  Waiting ${delay/1000} seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log(`\n🎉 Scraping complete!`);
    console.log(`✅ Successful: ${stats.successful}`);
    console.log(`❌ Failed: ${stats.failed}`);
    console.log(`🚫 Wrong player: ${stats.wrong_player}`);
    
    const finalData = {
      success: true,
      timestamp: new Date().toISOString(),
      current_nfl_season: getCurrentNFLSeason(),
      stats: stats,
      total_players: Object.keys(results).length,
      data: results
    };
    
    // Write to JSON file
    await fs.writeFile('player-data.json', JSON.stringify(finalData, null, 2));
    console.log(`📁 Data saved to player-data.json`);
    
    return finalData;
    
  } catch (error) {
    console.error('❌ Main scraping error:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  scrapeAllPlayers()
    .then(() => {
      console.log('🎯 Scraping completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Scraping failed:', error);
      process.exit(1);
    });
}

module.exports = { scrapeAllPlayers };