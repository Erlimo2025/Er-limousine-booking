// Test-only adapter; production always uses PostgreSQL.
const crypto=require('node:crypto');
function customerMemory(shared,failures={}) {
 shared.customers ||= new Map();shared.customerSessions ||= new Map();shared.customerLimits ||= new Map();
 const clone=x=>x?structuredClone(x):null;
 const fail=()=>{if(failures.read||failures.write)throw Object.assign(new Error('private-storage-marker'),{storageFailure:true});};
 return {
  updateCustomerProfile:async(id,hash,changes,now)=>{fail();const c=shared.customers.get(id),s=shared.customerSessions.get(hash);if(c?.account_status!=='active'||s?.customer_id!==id||s.expires<=now)return null;
   if(changes.phone&&[...shared.customers.values()].some(x=>x.id!==id&&x.normalized_phone===changes.phone.normalized))throw Object.assign(new Error('Unable to update profile with these details.'),{status:400});
   if(changes.fullName!==undefined)c.full_name=changes.fullName;if(changes.phone){c.normalized_phone=changes.phone.normalized;c.display_phone=changes.phone.display;}return clone(c);
  },
  ...require('./recovery-memory.cjs').recoveryMemory(shared,failures),
  customerByEmail:async email=>{fail();return clone([...shared.customers.values()].find(c=>c.normalized_email===email));},
  registerCustomer:async(c,s)=>{fail();if([...shared.customers.values()].some(x=>x.normalized_email===c.normalized_email||x.normalized_phone===c.normalized_phone))return false;shared.customers.set(c.id,{...c,account_status:'active'});shared.customerSessions.set(s.hash,{customer_id:c.id,expires:s.expires.getTime()});return true;},
  createCustomerSession:async(id,s,expectedPasswordHash)=>{fail();if(shared.customers.get(id)?.account_status!=='active'||shared.customers.get(id)?.password_hash!==expectedPasswordHash)return false;shared.customerSessions.set(s.hash,{customer_id:id,expires:s.expires.getTime()});return true;},
  resolveCustomerSession:async(hash,now)=>{fail();const s=shared.customerSessions.get(hash),c=s&&shared.customers.get(s.customer_id);return s&&s.expires>now&&c?.account_status==='active'?clone(c):null;},
  revokeCustomerSession:async hash=>{fail();shared.customerSessions.delete(hash);},
  customerLoginLimit:async(hash,now)=>{fail();let counter=shared.customerLimits.get(hash);if(!counter||counter.reset<=now){counter={count:0,reset:now+900000};shared.customerLimits.set(hash,counter);}return ++counter.count<=20;}
 };
}
module.exports={customerMemory};
