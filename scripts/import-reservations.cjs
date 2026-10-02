require('dotenv').config();
const fs=require('fs');
const {createStore,validateRecords}=require('../storage/postgres');
async function main() {
  let store;
  try {
    const file=process.argv[2]; if(!file)throw new Error();
    // Parse and validate the entire source before any insertion; never modify the source.
    const records=validateRecords(JSON.parse(fs.readFileSync(file,'utf8')));
    store=createStore(process.env);await store.migrate();
    const result=await store.importLegacy(records);
    console.log('Reservation import complete. Inserted: '+result.inserted+'; skipped existing: '+result.skipped+'.');
  } catch(_) {console.error('Reservation import failed. No import changes were committed. Check source format and database availability.');process.exitCode=1;}
  finally {if(store)await store.close();}
}
main();
