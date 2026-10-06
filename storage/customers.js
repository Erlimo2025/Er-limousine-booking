// All SQL is parameterized; failures never expose provider diagnostics.
function customerStorage(pool,transaction,safe) {
 const columns='c.id,c.full_name,c.display_email,c.display_phone';
 return {
  updateCustomerProfile:(id,hash,changes,now)=>transaction(async client=>{
   const customer=(await client.query("SELECT id FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",[id])).rows[0];
   if(!customer)return null;
   const session=await client.query('SELECT customer_id FROM er_customer_sessions WHERE token_hash=$1 AND customer_id=$2 AND expires_at>$3 FOR SHARE',[hash,id,new Date(now)]);
   if(!session.rowCount)return null;
   try{
    return (await client.query('UPDATE er_customers SET full_name=COALESCE($2,full_name),normalized_phone=COALESCE($3,normalized_phone),display_phone=COALESCE($4,display_phone),updated_at=$5 WHERE id=$1 RETURNING id,full_name,display_email,display_phone',[id,changes.fullName ?? null,changes.phone?.normalized ?? null,changes.phone?.display ?? null,new Date(now)])).rows[0];
   }catch(error){if(error.code==='23505')throw Object.assign(new Error('Unable to update profile with these details.'),{status:400});throw error;}
  }),
  customerByEmail:email=>safe(async()=> (await pool.query('SELECT * FROM er_customers WHERE normalized_email=$1',[email])).rows[0] || null),
  registerCustomer:(c,s)=>transaction(async client=>{
   const row=(await client.query('INSERT INTO er_customers(id,full_name,normalized_email,display_email,normalized_phone,display_phone,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',[c.id,c.full_name,c.normalized_email,c.display_email,c.normalized_phone,c.display_phone,c.password_hash])).rows[0];
   if(!row)return false;
   await client.query('INSERT INTO er_customer_sessions(token_hash,customer_id,created_at,expires_at,last_used_at) VALUES($1,$2,$3,$4,$3)',[s.hash,c.id,s.created,s.expires]);return true;
  }),
  createCustomerSession:(id,s,expectedPasswordHash)=>transaction(async client=>{
   const current=(await client.query("SELECT password_hash FROM er_customers WHERE id=$1 AND account_status='active' FOR UPDATE",[id])).rows[0];
   if(!current || current.password_hash!==expectedPasswordHash)return false;
   const r=await client.query("INSERT INTO er_customer_sessions(token_hash,customer_id,created_at,expires_at,last_used_at) SELECT $1,id,$3,$4,$3 FROM er_customers WHERE id=$2 AND account_status='active' RETURNING token_hash",[s.hash,id,s.created,s.expires]);return r.rowCount===1;
  }),
  resolveCustomerSession:(hash,now)=>safe(async()=>{
   const r=await pool.query("UPDATE er_customer_sessions s SET last_used_at=$2 FROM er_customers c WHERE s.token_hash=$1 AND s.customer_id=c.id AND s.expires_at>$2 AND c.account_status='active' RETURNING "+columns,[hash,new Date(now)]);return r.rows[0] || null;
  }),
  revokeCustomerSession:hash=>safe(async()=>{await pool.query('DELETE FROM er_customer_sessions WHERE token_hash=$1',[hash]);}),
  customerLoginLimit:(hash,now)=>safe(async()=>{
   const r=await pool.query('INSERT INTO er_customer_auth_limits(identity_hash,attempts,reset_at) VALUES($1,1,$3) ON CONFLICT(identity_hash) DO UPDATE SET attempts=CASE WHEN er_customer_auth_limits.reset_at<=$2 THEN 1 ELSE er_customer_auth_limits.attempts+1 END, reset_at=CASE WHEN er_customer_auth_limits.reset_at<=$2 THEN $3 ELSE er_customer_auth_limits.reset_at END RETURNING attempts',[hash,new Date(now),new Date(now+15*60*1000)]);return r.rows[0].attempts<=20;
  })
 };
}
module.exports={customerStorage};
