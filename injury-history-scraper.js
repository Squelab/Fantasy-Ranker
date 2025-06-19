const axios = require('axios');
const cheerio = require('cheerio');

// Generate clean URL slug from player name
function generatePlayerSlug(playerName) {
  return playerName
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

// Generate URL variations for Fox Sports
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

// Extract position from Fox Sports player header
function extractPositionFromPage($) {
  // Look for pattern like "#8 - QUARTERBACK - BALTIMORE RAVENS"
  const headerText = $('.entity-header-wrapper, .player-header, h1, h2').text().toUpperCase();
  
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

// Extract injury data from page
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
  return injuries.some(injury => 
    parseInt(injury.season) >= 2023
  );
}

// Test finding the correct player URL and validating
async function testPlayerValidation(playerName, expectedPosition) {
  console.log(`\n🔍 Testing: ${playerName} (expected: ${expectedPosition})`);
  
  const urlVariations = generateFoxSportsVariations(playerName);
  
  for (const [index, urlSuffix] of urlVariations.entries()) {
    try {
      const url = `https://www.foxsports.com/nfl/${urlSuffix}`;
      console.log(`  Trying: ${urlSuffix}`);
      
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      
      // Extract position from page
      const pagePosition = extractPositionFromPage($);
      console.log(`    Found position: ${pagePosition}`);
      
      // Extract injury data
      const injuries = extractInjuryData($);
      console.log(`    Found ${injuries.length} injury entries`);
      
      if (injuries.length > 0) {
        console.log(`    Sample injuries:`, injuries.slice(0, 3));
      }
      
      // Check if position matches expected
      const positionMatch = pagePosition === expectedPosition;
      console.log(`    Position match: ${positionMatch}`);
      
      // Check recent activity
      const recentActivity = hasRecentActivity(injuries);
      console.log(`    Recent activity: ${recentActivity}`);
      
      // Validation logic
      if (positionMatch && (recentActivity || injuries.length === 0)) {
        console.log(`✅ SUCCESS: Found ${playerName} at ${urlSuffix}`);
        console.log(`    Position: ${pagePosition}, Injuries: ${injuries.length}, Recent: ${recentActivity}`);
        return {
          success: true,
          url: urlSuffix,
          position: pagePosition,
          injuries: injuries,
          hasRecentActivity: recentActivity
        };
      } else if (positionMatch && !recentActivity && injuries.length > 0) {
        console.log(`⚠️  POSITION MATCH but no recent activity - might be retired player`);
      }
      
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`    404 - URL not found`);
      } else {
        console.log(`    Error: ${error.message}`);
      }
    }
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`❌ FAILED: Could not find valid URL for ${playerName}`);
  return { success: false };
}

// Test cases
async function runValidationTests() {
  console.log('🚀 Starting Fox Sports Player Validation Tests\n');
  
  const testCases = [
    { name: 'Josh Allen', position: 'QB' },
    { name: 'Marvin Harrison', position: 'WR' },  // Should find marvin-harrison-2
    { name: 'Odell Beckham', position: 'WR' },   // Should find odell-beckham-jr
    { name: 'Lamar Jackson', position: 'QB' },   // Should find base URL
    { name: 'Calvin Ridley', position: 'WR' },   // Test another case
  ];
  
  const results = [];
  
  for (const testCase of testCases) {
    const result = await testPlayerValidation(testCase.name, testCase.position);
    results.push({
      ...testCase,
      ...result
    });
    
    // Delay between players
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  console.log('\n📊 VALIDATION TEST RESULTS:');
  console.log('================================');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful: ${successful.length}/${results.length}`);
  console.log(`❌ Failed: ${failed.length}/${results.length}`);
  
  if (successful.length > 0) {
    console.log('\n✅ Successful validations:');
    successful.forEach(r => {
      console.log(`  ${r.name} (${r.position}) → ${r.url} (${r.injuries.length} injuries)`);
    });
  }
  
  if (failed.length > 0) {
    console.log('\n❌ Failed validations:');
    failed.forEach(r => {
      console.log(`  ${r.name} (${r.position})`);
    });
  }
  
  return results;
}

// Run if called directly
if (require.main === module) {
  runValidationTests()
    .then(() => {
      console.log('\n🎯 Validation testing completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Validation testing failed:', error);
      process.exit(1);
    });
}

module.exports = { testPlayerValidation, runValidationTests };