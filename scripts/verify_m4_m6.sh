#!/usr/bin/env bash
# M4+M6 verification — POST /api/dossier/email four guard paths, live.
set -u
BASE="http://localhost:81/api/dossier/email"
GULF="cmvtcxblv0005m3jea8z7y7n7"        # us, caslScope=false, QLV 94  -> happy path (staged)
MAPLE="cmvtcxbmm001bm3jepdvscohu"       # ca, caslScope=true            -> flip false, expect CASL 403, restore
BAYOU="cmvtcxblz000bm3je5fvdzb7l"       # us                            -> suppress, expect 403, unsuppress
NORTH="cmvtcxbmc000tm3jeuzvxeksk"       # us, QLV 87                    -> override proof
J() { python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d)[:400])" 2>/dev/null || cat; }

echo "== 0. invalid payload (expect 400 invalid_payload)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"body\":\"no subject\"}" | J

echo "== 0b. unknown prospect (expect 404)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d '{"prospectId":"cmvDOESNOTEXIST000000000","subject":"x","body":"y"}' | J

echo "== 1. CASL hard gate — Maple (ca) flipped to caslScope=false (expect 403 casl_consent_required)"
npx tsx -e "import{PrismaClient}from'@prisma/client';const d=new PrismaClient();d.prospect.update({where:{id:'$MAPLE'},data:{caslScope:false}}).then(()=>d.\$disconnect())" 2>/dev/null
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$MAPLE\",\"subject\":\"cold outreach\",\"body\":\"hello\"}" | J
npx tsx -e "import{PrismaClient}from'@prisma/client';const d=new PrismaClient();d.prospect.update({where:{id:'$MAPLE'},data:{caslScope:true}}).then(()=>d.\$disconnect())" 2>/dev/null
echo "   (caslScope restored to true)"

echo "== 2. Suppression — Bayou suppressed (expect 403 suppressed)"
npx tsx -e "import{PrismaClient}from'@prisma/client';const d=new PrismaClient();d.suppressionRecord.create({data:{email:'dwhitfield@bayoupipe.com',prospectId:'$BAYOU',reason:'unsubscribe',source:'operator'}}).then(()=>d.\$disconnect())" 2>/dev/null
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$BAYOU\",\"subject\":\"cold outreach\",\"body\":\"hello\"}" | J
npx tsx -e "import{PrismaClient}from'@prisma/client';const d=new PrismaClient();d.suppressionRecord.deleteMany({where:{prospectId:'$BAYOU'}}).then(()=>d.\$disconnect())" 2>/dev/null
echo "   (suppression record removed)"

echo "== 3. Happy path — Gulf Coast (expect 200, mode staged, no_provider)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"subject\":\"Gulf Coast Valve: RFQ turnaround\",\"body\":\"Mr Webb — quoting latency benchmark, 3-slide teardown on offer.\"}" | J

echo "== 4. Cooldown — immediate re-send Gulf Coast (expect 409 cooldown_active)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"subject\":\"second attempt\",\"body\":\"hello again\"}" | J

echo "== 5. Override — Northline first send, then forced resend (both expect 200 staged)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$NORTH\",\"subject\":\"Northline Electric: quoting benchmark\",\"body\":\"opening note\"}" | J
curl -s -w " [%{http_code}]\n" -X POST "$BASE" -H 'content-type: application/json' \
  -d "{\"prospectId\":\"$NORTH\",\"subject\":\"Northline Electric: follow-up\",\"body\":\"forced resend\",\"override\":true}" | J

echo "== 6. Ledger truth — dispatches + operator actions written"
npx tsx -e "
import{PrismaClient}from'@prisma/client';const d=new PrismaClient();
(async()=>{
  const ds=await d.dispatch.findMany({where:{channel:'operator_manual_email'},orderBy:{createdAt:'asc'},select:{prospectId:true,status:true,provider:true,footerApplied:true,error:true,subject:true}});
  ds.forEach(x=>console.log('DISPATCH',[x.prospectId.slice(-6),x.status,x.provider,x.footerApplied,x.error,x.subject.slice(0,30)].join(' | ')));
  const as=await d.operatorAction.findMany({where:{action:'emailed'},orderBy:{createdAt:'asc'},select:{prospectId:true,note:true}});
  as.forEach(x=>console.log('ACTION  ',[x.prospectId.slice(-6),x.note.slice(0,48)].join(' | ')));
  const m=await d.prospect.findUnique({where:{id:'$MAPLE'},select:{caslScope:true}});
  console.log('MAPLE caslScope restored:',m&&m.caslScope);
  const s=await d.suppressionRecord.count();console.log('suppression count:',s);
  await d.\$disconnect();})()" 2>/dev/null
