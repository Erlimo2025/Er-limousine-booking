const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const archiveError=(status=409,message='Trip archive unavailable. Refresh and try again.')=>Object.assign(new Error(message),{status});
function archiveInput(id,body){
 if(typeof id!=='string'||!uuid.test(id)||!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='confirmed,requestId'||body.confirmed!==true||typeof body.requestId!=='string'||!uuid.test(body.requestId))throw archiveError(400,'Invalid archive request.');
}
function canArchive(record,finish,now){
 if(['cancelled','completed'].includes(record.status))return true;
 // A missed pickup time never makes an in-progress dispatch safe to hide.
 return ['awaiting_payment','confirmed'].includes(record.status)&&finish!=null&&Number.isFinite(new Date(finish).getTime())&&new Date(finish).getTime()<=now;
}
function adminArchiveStorage(transaction,validate,assertActionLock){return {
 adminArchiveState:id=>transaction(async client=>{
  if(typeof id!=='string'||!uuid.test(id))return null;
  const row=(await client.query('SELECT archived_at,archived_by FROM er_reservations WHERE id=$1',[id])).rows[0];return row || null;
 }),
 manageAdminArchive:(auth,id,input,action,now)=>transaction(async client=>{
  archiveInput(id,input);if(!['archive','restore'].includes(action)||!uuid.test(auth.actorId)||!auth.authorized())throw archiveError(401,'Authentication required.');
  const {legacyEnd}=require('./admin-reservations');
  const row=(await client.query(`SELECT record,archived_at,archived_by,COALESCE(scheduled_end_at,${legacyEnd}) AS finish FROM er_reservations WHERE id=$1 FOR UPDATE`,[id])).rows[0];
  if(!row)throw archiveError(404,'Booking not found.');validate(row.record);
  assertActionLock(row.record.checkoutFingerprint || 'reservation:'+id);
  if(!auth.authorized())throw archiveError(401,'Authentication required.');
  const replay=(await client.query('SELECT action FROM er_admin_trip_archive_events WHERE booking_id=$1 AND request_id=$2',[id,input.requestId])).rows[0];
  if(!auth.authorized())throw archiveError(401,'Authentication required.');
  if(replay){if(replay.action!==action)throw archiveError();return {changed:false,archived:row.archived_at!==null};}
  if(action==='archive'&&!row.archived_at&&!canArchive(row.record,row.finish,now))throw archiveError(409,'Cancel or complete an active trip before archiving it.');
  const changed=action==='archive'?!row.archived_at:!!row.archived_at;
  if(changed)await client.query('UPDATE er_reservations SET archived_at=$2,archived_by=$3 WHERE id=$1',[id,action==='archive'?new Date(now):null,action==='archive'?auth.actorId:null]);
  await client.query('INSERT INTO er_admin_trip_archive_events(booking_id,request_id,action,actor_id,occurred_at,changed) VALUES($1,$2,$3,$4,$5,$6)',[id,input.requestId,action,auth.actorId,new Date(now),changed]);
  if(!auth.authorized())throw archiveError(401,'Authentication required.');
  return {changed,archived:action==='archive'};
 })
};}
module.exports={uuid,archiveInput,canArchive,archiveError,adminArchiveStorage};
