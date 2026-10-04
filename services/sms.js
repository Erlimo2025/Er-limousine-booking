// No live provider or credential loading exists in this phase.
// A reviewed provider adapter must be explicitly connected before enabling recovery.
function createSmsProvider({enabled=false}={}) {
 if(enabled)throw new Error('Customer recovery provider unavailable.');
 return {enabled:false,sendCode:async()=>{throw new Error('Customer recovery unavailable.');}};
}
module.exports={createSmsProvider};
