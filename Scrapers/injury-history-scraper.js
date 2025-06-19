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

// Generate Fox Sports URL variations
function generateFoxSportsVariations(playerName) {
  const baseSlug = generatePlayerSlug(playerName);
  
  return [
    `${baseSlug}-player-injuries`,           // josh-allen-player-injuries
    `${baseSlug}-2-player-injuries`,         // josh-allen-2-player-injuries  
    `${baseSlug}-3-player-injuries`,         // josh-allen-3-player-injuries
    `${baseSlug}-jr-player-injuries`,        // odell-beckham-jr-player-injuries
    `${baseSlug}-sr-player-injuries`,        // josh-allen-sr-player-injuries
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

// Extract position from Fox Sports player header
function extractPositionFromPage($) {
  // Look for pattern like "#8 - QUARTERBACK - BALTIMORE RAVENS"
  const headerText = $('body').text().toUpperCase();
  
  // Common position patterns
  const positionMappings = {
    'QUARTERBACK': 'QB',
    'RUNNING BACK': 'RB', 
    'WIDE RECEIVER': 'WR',
    'TIGHT END': 'TE',
    'QB': 'QB',
    'RB': 'RB', 
    'WR': 'WR',
    'TE': 'TE'
  };
  
  for (const [longForm, shortForm] of Object.entries(positionMappings)) {
    if (headerText.includes(longForm)) {
      return shortForm;
    }
  }
  
  return null;
}

// Extract injury data from Fox Sports page
function extractInjuryData($) {
  const injuries = [];
  
  // Look for injury table rows
  $('tr').each((index, row) => {
    const $row = $(row);
    const cells = [];
    
    $row.find('td, th').each((i, cell) => {
      cells.push($(cell).text().trim());
    });
    
    // Skip header rows and empty rows
    // Look for rows with season data (4-digit year)
    if (cells.length >= 4 && 
        !cells[0].toLowerCase().includes('season') && 
        cells[0].match(/^\d{4}$/)) {
      
      injuries.push({
        season: cells[0],
        week: cells[1], 
        injury: cells[2],
        status: cells[3]
      });
    }
  });
  
  return injuries;
}

// Check if player has recent injury activity (2023+)
function hasRecentActivity(injuries) {
  if (injuries.length === 0) return false;
  return injuries.some(injury => 
    parseInt(injury.season) >= 2023
  );
}

// Scrape injury data for a specific player
async function scrapePlayerInjuries(player, adpPlayers) {
  console.log(`\n🔍 Processing: ${player.name} (${player.position})`);
  
  const urlVariations = generateFoxSportsVariations(player.name);
  
  for (const [index, urlSuffix] of urlVariations.entries()) {
    try {
      const url = `https://www.foxsports.com/nfl/${urlSuffix}`;
      
      console.log(`📊 ${player.name}: Trying ${urlSuffix}`);
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      
      // Check for obvious error pages
      const pageText = $('body').text().toLowerCase();
      if (pageText.includes('page not found') || 
          pageText.includes('404 error') ||
          pageText.includes('does not exist') ||
          pageText.length < 500) {  // Very short pages are likely errors
        continue;
      }
      
      // Check if this looks like a real player page
      const hasPlayerElements = $('body').text().includes('INJURIES') || 
                               $('body').text().includes('STATS') ||
                               $('body').text().includes('GAME LOG') ||
                               $('body').text().includes('NEWS');
      
      if (!hasPlayerElements) {
        console.log(`    Not a player page - missing player elements`);
        continue;
      }
      
      // Extract injury data (but don't require it)
      const injuries = extractInjuryData($);
      const recentActivity = hasRecentActivity(injuries);
      
      console.log(`✅ ${player.name}: Found valid player page at ${urlSuffix}`);
      console.log(`    Injuries: ${injuries.length}, Recent: ${recentActivity}`);
      
      return {
        name: player.name,
        position: player.position,
        team: player.team,
        adp: player.adp,
        injuries: injuries,
        total_injuries: injuries.length,
        has_recent_injuries: recentActivity,
        url_used: urlSuffix,
        scraped_at: new Date().toISOString()
      };
      
    } catch (error) {
      if (error.response && error.response.status === 404) {
        continue;
      }
      console.error(`❌ Error with ${urlSuffix}:`, error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  console.log(`❌ ${player.name}: Could not find valid URL`);
  return null;
}

// Main scraping function
async function scrapeAllPlayerInjuries() {
  try {
    console.log('🚀 Starting Fox Sports injury scraping...');
    console.log(`📅 Current NFL season: ${getCurrentNFLSeason()}`);
    
    const players = await getTop250Players();
    const batchSize = parseInt(process.env.BATCH_SIZE) || 5;
    
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
          const playerData = await scrapePlayerInjuries(player, players);
          
          if (playerData) {
            stats.successful++;
            console.log(`✅ #${i + batch.indexOf(player) + 1}: ${player.name} - ${playerData.total_injuries} injuries`);
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
        const delay = 2000;
        console.log(`⏱️  Waiting ${delay/1000} seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log(`\n🎉 Injury scraping complete!`);
    console.log(`✅ Successful: ${stats.successful}`);
    console.log(`❌ Failed: ${stats.failed}`);
    console.log(`🚫 Wrong player: ${stats.wrong_player}`);
    
    // Calculate total injuries
    const totalInjuries = Object.values(results).reduce((sum, player) => sum + player.total_injuries, 0);
    
    const finalData = {
      success: true,
      timestamp: new Date().toISOString(),
      current_nfl_season: getCurrentNFLSeason(),
      stats: stats,
      total_players: Object.keys(results).length,
      total_injuries: totalInjuries,
      data: results
    };
    
    // Create output directory
    await fs.mkdir('For-AI/Injury', { recursive: true });
    
    // Write to JSON file
    await fs.writeFile('For-AI/Injury/injury-history.json', JSON.stringify(finalData, null, 2));
    console.log(`📁 Data saved to For-AI/Injury/injury-history.json`);
    
    return finalData;
    
  } catch (error) {
    console.error('❌ Main injury scraping error:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  scrapeAllPlayerInjuries()
    .then(() => {
      console.log('🎯 Injury scraping completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Injury scraping failed:', error);
      process.exit(1);
    });
}

module.exports = { scrapeAllPlayerInjuries };
