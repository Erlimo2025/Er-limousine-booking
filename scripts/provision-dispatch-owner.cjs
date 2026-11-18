'use strict';

// No .env loader, application startup, workers, providers, or automatic migration.
// Credentials are supplied by a private terminal or explicit stdin JSON, never argv.
const crypto=require('node:crypto');
const {Writable}=require('node:stream');
const {createInterface}=require('node:readline/promises');
const {hashPassword,passwordValid,email}=require('../auth/customers');
const {encryptionKey}=require('../auth/dispatch-owner');
const {createStore}=require('../storage/postgres');

async function input(recover) {
  if(process.argv.slice(2).some(a=>!['--recover','--stdin'].includes(a)))throw Error();
  if(process.argv.includes('--stdin')) {
    if(process.stdin.isTTY)throw Error();
    let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>8192)throw Error();}
    return JSON.parse(text);
  }
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error();
  let muted=false;
  const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
  output.isTTY=true;output.columns=process.stdout.columns;
  // A later unmuted prompt must never recall a hidden password with Up/history.
  const rl=createInterface({input:process.stdin,output,terminal:true,historySize:0});
  try {
    const values={};
    if(!recover)values.name=await rl.question('Owner display name: ');
    values.email=await rl.question('Owner login address: ');
    process.stdout.write('New owner password (hidden): ');muted=true;
    values.password=await rl.question('');muted=false;process.stdout.write('\n');
    process.stdout.write('Repeat password (hidden): ');muted=true;
    const repeated=await rl.question('');muted=false;process.stdout.write('\n');if(repeated!==values.password)throw Error();
    if(recover)values.evidenceReference=await rl.question('Secure recovery evidence reference (no personal details): ');
    values.confirmation=await rl.question(recover?'Type RESET OWNER MFA AND REVOKE ALL SESSIONS: ':'Type PROVISION ONE OWNER: ');
    return values;
  }finally {muted=false;rl.close();}
}
async function main() {
  let store;
  try {
    const recover=process.argv.includes('--recover');
    if(process.env.DISPATCH_OWNER_ENABLED!=='true')throw Error();
    encryptionKey(process.env.DISPATCH_MFA_KEY);
    const values=await input(recover),e=email(values.email);
    if(!e||!passwordValid(values.password)||[...values.password].length<14||values.confirmation!==(recover?'RESET OWNER MFA AND REVOKE ALL SESSIONS':'PROVISION ONE OWNER'))throw Error();
    if(!recover&&(typeof values.name!=='string'||values.name.trim().length<2||values.name.trim().length>120||/[\x00-\x1f\x7f<>]/.test(values.name)))throw Error();
    if(recover&&(typeof values.evidenceReference!=='string'||!values.evidenceReference.trim()||values.evidenceReference.length>120||/[\x00-\x1f\x7f]/.test(values.evidenceReference)))throw Error();
    const passwordHash=await hashPassword(values.password),referenceId=crypto.randomUUID();
    const audit={timestamp:new Date().toISOString(),referenceId,action:recover?'owner_emergency_recovery':'owner_provisioned',outcome:'succeeded'};
    store=createStore(process.env);
    if(recover)await store.dispatchEmergencyRecovery({email:e.normalized,passwordHash,audit});
    else await store.dispatchProvisionOwner({name:values.name.trim(),email:e.normalized,passwordHash,audit});
    console.log(recover?'Owner recovery reset completed. All prior sessions and recovery codes were revoked. MFA enrollment is required.':'Owner provisioned. Private sign-in and MFA enrollment are required before Dispatch access.');
    console.log('Operational reference: '+referenceId);
    if(recover)console.log('Record this reference with the verification evidence in the secure recovery log.');
  }catch(_){console.error('Owner setup failed. Check private input, authorization, migration and database availability. No credentials or diagnostic details are printed.');process.exitCode=1;}
  finally {if(store)await store.close();}
}
if(require.main===module)void main();
module.exports={input,main};
