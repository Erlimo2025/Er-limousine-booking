// Test-only adapter; production always uses PostgreSQL.
const crypto=require('node:crypto');
function customerMemory(shared,failures={}) {
 shared.customers ||= new Map();shared.customerSessions ||= new Map();shared.customerLimits ||= new Map();
 const clone=x=>x?structuredClone(x):null;
 const fail=()=>{if(failures.read||failures.write)throw Object.assign(new Error('private-storage-marker'),{storageFailure:true});};
 return {
  customerByEmail:async email=>{fail();return clone([...shared.customers.values()].find(c=>c.normalized_email===email));},
  registerCustomer:async(c,s)=>{fail();if([...shared.customers.values()].some(x=>x.normalized_email===c.normalized_email||x.normalized_phone===c.normalized_phone))return false;shared.customers.set(c.id,{...c,account_status:'active'});shared.customerSessions.set(s.hash,{customer_id:c.id,expires:s.expires.getTime()});return true;},
  createCustomerSession:async(id,s)=>{fail();if(shared.customers.get(id)?.account_status!=='active')return false;shared.customerSessions.set(s.hash,{customer_id:id,expires:s.expires.getTime()});return true;},
  resolveCustomerSession:async(hash,now)=>{fail();const s=shared.customerSessions.get(hash),c=s&&shared.customers.get(s.customer_id);return s&&s.expires>now&&c?.account_status==='active'?clone(c):null;},
  revokeCustomerSession:async hash=>{fail();shared.customerSessions.delete(hash);},
  customerLoginLimit:async(hash,now)=>{fail();let counter=shared.customerLimits.get(hash);if(!counter||counter.reset<=now){counter={count:0,reset:now+900000};shared.customerLimits.set(hash,counter);}return ++counter.count<=20;}
 };
}
module.exports={customerMemory};