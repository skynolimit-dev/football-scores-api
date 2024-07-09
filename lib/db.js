
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue, Filter } = require('firebase-admin/firestore');
const path = require('path');
const db = initDb();
const _ = require('lodash');

// Initialize the Firestore database
function initDb() {

    // Use the dev key by default
    let serviceAccountPath = path.resolve(__dirname, '../assets/firestore/football-scores-api-dev-firebase-adminsdk-40b5x-5da37022ea.json');

    // If NODE_ENV is production, use the prod key
    if (process.env.NODE_ENV === 'production')
        serviceAccountPath = path.resolve(__dirname, '../assets/firestore/football-scores-api-db-firebase-adminsdk-46gll-0451286511.json');

    const serviceAccount = require(serviceAccountPath);

    try {
        initializeApp({
            credential: cert(serviceAccount)
        });
        const db = getFirestore();
        db.settings({ ignoreUndefinedProperties: true })
        console.log('Firestore initialized using ', process.env.NODE_ENV === 'production' ? 'production' : 'development', 'key');
        return db;
    } catch (error) {
        console.error('Error initializing Firestore: ', error);
    }

}


// Retrieve a document from Firestore
async function get(collection, key) {
    console.log(`[DB]: Getting document ${key} from collection ${collection}`);
    try {
        // console.log(`[DB]: Getting document ${key} from collection ${collection}`);
        const docRef = db.collection(collection).doc(key);
        const doc = await docRef.get();
        if (!doc.exists) {
            console.log(`No such document: ${key}`);
            return null;
        } else {
            return doc.data();
        }
    } catch (error) {
        console.error(`Unable to get document with key ${key} from collection ${collection}`, error);
    }
}

// Retrieve all documents from a Firestore collection
async function getAll(collection) {
    try {
        const snapshot = await db.collection(collection).get();
        let docs = [];
        snapshot.forEach(doc => {
            docs.push(doc.data());
        });
        return docs;
    } catch (error) {
        console.error(`Unable to get all documents from collection ${collection}`, error);
    }
}

// Save a document to Firestore
async function set(collection, key, value) {
    console.log(`[DB]: Setting document ${key} in collection ${collection}`);
    try {
        const docRef = db.collection(collection).doc(key);
        await docRef.set(value);
        return true;
    } catch (error) {
        console.error(`Error setting document with key ${key} in collection ${collection}`, error);
    }
    return false;
}

module.exports = {
    db,
    get,
    getAll,
    set
}