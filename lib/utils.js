const fs = require('fs');
const path = require('path');
const _ = require('lodash');

// Returns an array of all files found in the given directory path
function getAllFileNames(directoryPath) {
  const fileNames = [];
  try {
    // Synchronously read all files in the directory
    const files = fs.readdirSync(directoryPath);

    // Iterate through each file
    files.forEach(file => {
      const filePath = path.join(directoryPath, file);
      const stats = fs.statSync(filePath);

      // Check if it's a file (not a directory)
      if (stats.isFile()) {
        fileNames.push(file);
      }
    });
  } catch (err) {
    console.error('Error reading directory:', err);
  }
  return fileNames;
}


// "Expands" the given match JSON object to make a "sane" structure for ingestion by the app...
// For each match, it expands any keys with double underscores into nested objects, e.g.
// replaces this...
// "competition__name": "Scottish Premiership Play-offs",
// "competition__subHeading": "Play-offs - Semi-finals",
// "competition__weight": 0
// with this...
// "competition": {
//     "name": "Scottish Premiership Play-offs",
//     "subHeading": "Play-offs - Semi-finals",
//     "weight": 0
// }
function getJsonExpanded(match) {
  let processedMatch = {};
  for (const [key, value] of Object.entries(match)) {
      if (key.includes('__')) {
          _.set(processedMatch, key.replaceAll('__', '.'), value);
      } else {
          processedMatch[key] = value;
      }
  }
  return processedMatch;
}

module.exports = {
  getAllFileNames,
  getJsonExpanded
}