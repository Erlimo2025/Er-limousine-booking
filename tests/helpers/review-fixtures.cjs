const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createRequire}=require('node:module');
const anchor=path.join(__dirname,'../security-abuse.test.cjs');
const source=fs.readFileSync(anchor,'utf8').replace('server.listen(0, "127.0.0.1", resolve)','server.listen(Number(env.PORT || 0), "127.0.0.1", resolve)');
const {harness,booking}=new Function('require','__dirname',source.slice(0,source.indexOf('test("approved prices'))+'\nreturn {harness,booking};')(createRequire(anchor),path.dirname(anchor));
const secret=Buffer.alloc(32,17).toString('base64url');
async function create(t,env={},store,browser=false,saved='[]'){
 if(browser){const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));env={...env,PORT:String(port),SITE_URL:'http://127.0.0.1:'+port};}
 return harness(t,{BOOKING_EMAILS_ENABLED:'true',COMPANY_EMAIL:'ops@example.test',REVIEW_INVITATION_SECRET:secret,ROUTE_TOLLS_ENABLED:'false',ADMIN_TOLL_VALIDATION_ENABLED:'false',...env},saved,store);
}
const origin=h=>h.context.process.env.SITE_URL || 'http://localhost:3000';
const cookie=r=>r.headers.getSetCookie()[0].split(';')[0];
const login=async h=>cookie(await h.request('/api/admin/login',{token:'local-test-token'}));
const reserve=(h,extra={},headers={})=>h.request('/api/checkout',{...booking,vehicle:'suv',paymentChoice:'later',...extra},headers);
const complete=(h,id,admin,status='completed')=>h.request('/api/bookings/'+id,{status},{cookie:admin,origin:origin(h),'sec-fetch-site':'same-origin'},'PATCH');
const flush=h=>h.context.runBookingEmails();
const calls=h=>h.state.bookingCalls.filter(m=>m.subject==='How Was Your Ride? | ER Limousine Service');
const messages=h=>h.state.bookingMessages.filter(m=>m.subject==='How Was Your Ride? | ER Limousine Service');
const token=message=>new URL(message.text.match(/Rate Your Experience: (\S+)/)[1]).hash.slice(7);
const submit=(h,raw,rating=3,comment,headers={})=>h.request('/api/reviews',{token:raw,rating,...(comment===undefined?{}:{comment})},{origin:origin(h),'sec-fetch-site':'same-origin',...headers});
const moderate=(h,id,admin,extra={})=>h.request('/api/admin/reviews/'+id+'/moderate',{action:'publish',reason:'authentic_feedback',requestId:require('node:crypto').randomUUID(),confirmed:true,version:0,...extra},{cookie:admin,origin:origin(h),'sec-fetch-site':'same-origin'});
async function ready(t,env={},store){const h=await create(t,env,store),admin=await login(h),r=await reserve(h);if(r.status!==200)throw Error('Fixture reservation failed');const id=r.body.bookingId;const done=await complete(h,id,admin);if(done.status!==200)throw Error('Fixture completion failed');await flush(h);return {h,admin,id,raw:token(calls(h)[0])};}
module.exports={create,booking,secret,origin,cookie,login,reserve,complete,flush,calls,messages,token,submit,moderate,ready};
