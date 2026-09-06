// scripts/revert-alias-repoints.js
//
// Puts back the alias entries changed by find-misrouted-appearances.js --apply on
// 2026-09-05 at 12:31. Reads nothing but the table below, writes players/aliases/.
//
// WHY THIS EXISTS
// ───────────────
// That run repointed 117 foreign aliases across 103 players. The rule was: where
// ONE same-name claimant is credited with EVERY x entry on a player, repoint every
// foreign alias aimed at that player.
//
// The evidence only ever supported the first half. That one claimant holds all the
// misrouted games says nothing about WHICH alias carried WHICH games. Where a
// player had several foreign aliases, the repair moved them all, including ones
// that were carrying games PlayHQ credits to the player themselves.
//
// It shows on William Warren (622098f3): 262 games before, 65 after, against a gp
// of 78 whose per-season figures sum to exactly 78. Three foreign aliases were
// repointed for him. Two were almost certainly right; one was his, and 13 real
// appearances went with it.
//
// THE SPLIT THAT MATTERS
//   46 of the 117 belong to players who had exactly ONE foreign alias. With one
//      alias there is nothing to attribute wrongly - every misrouted game came
//      through it. Those repairs are sound.
//   71 belong to the 28 players who had MORE THAN ONE. Those are the exposed set.
//
// --scope=multi reverts only the 71. --scope=all reverts all 117.
//
// SAFETY. Every entry is re-checked against the file on disk before it is
// restored: if the alias no longer holds the value this run wrote, it has been
// changed by something else since and is left alone rather than overwritten.

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const ALIAS_DIR = path.join(ROOT, 'players', 'aliases');

const args   = process.argv.slice(2);
const argVal = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const SCOPE  = String(argVal('scope', 'multi')).toLowerCase();
const APPLY  = args.includes('--apply');

if (!['multi', 'all'].includes(SCOPE)) {
  console.error('Usage: node scripts/revert-alias-repoints.js [--scope=multi|all] [--apply]');
  process.exit(1);
}

const log = (m) => console.log(`[revert] ${new Date().toISOString()} ${m}`);

// The exact table written by the 2026-09-05 12:31 apply run.
//   s     alias shard file
//   k     the spectator id (the key)
//   old   what it pointed at BEFORE that run  <- what a revert restores
//   now   what that run changed it to
//   multi true when the player had more than one foreign alias repointed
const ROWS = [
  {s:"3a",k:"3ac987b2-6116",old:"0e2a221b-b369-4509-a4d5-937b47af0b02",now:"b47867df-f18b-481c-9fbb-6dd48a1437e1",multi:false},
  {s:"40",k:"4091aa80-a800",old:"951392e2-30b2-45b3-b089-0b4b332ac86b",now:"e57c7ec0-51ca-4d6f-8f9e-085e6da89470",multi:false},
  {s:"7c",k:"7c3192b9-9850",old:"26dae995-9fbe-42bc-be3c-cb3be142e5e2",now:"887b7ee0-0cdf-408e-8ec6-fd5f62424606",multi:true},
  {s:"7d",k:"7dd2cfc1-4662",old:"26dae995-9fbe-42bc-be3c-cb3be142e5e2",now:"887b7ee0-0cdf-408e-8ec6-fd5f62424606",multi:true},
  {s:"60",k:"60f4b88c-5f2b",old:"026ea620-51a3-452a-913c-d2ef5342b3fd",now:"49a70ce7-9f26-4aa8-b6f9-6f44ea3e4bed",multi:true},
  {s:"e4",k:"e477b22e-0323",old:"026ea620-51a3-452a-913c-d2ef5342b3fd",now:"49a70ce7-9f26-4aa8-b6f9-6f44ea3e4bed",multi:true},
  {s:"e8",k:"e865489f-bc96",old:"026ea620-51a3-452a-913c-d2ef5342b3fd",now:"49a70ce7-9f26-4aa8-b6f9-6f44ea3e4bed",multi:true},
  {s:"79",k:"79bf1105-2b60",old:"df9dde1c-4b30-4eae-a439-45d6de208e5a",now:"702d0ce6-fbd9-4122-9783-b92ae7918b5c",multi:false},
  {s:"ae",k:"ae121dcb-12f3",old:"0a8d5942-769c-447f-8ffb-ca97cdfcc242",now:"6d6ba32a-6f82-45f4-9d73-e203140f92f4",multi:false},
  {s:"22",k:"220b577e-eae5",old:"76a3d064-71c2-4bec-85e6-d7b854290cd2",now:"ee243c4c-6d02-49b6-8e02-2f3120979b34",multi:true},
  {s:"9c",k:"9c7c699f-5f7f",old:"76a3d064-71c2-4bec-85e6-d7b854290cd2",now:"ee243c4c-6d02-49b6-8e02-2f3120979b34",multi:true},
  {s:"a1",k:"a1867621-ff4b",old:"76a3d064-71c2-4bec-85e6-d7b854290cd2",now:"ee243c4c-6d02-49b6-8e02-2f3120979b34",multi:true},
  {s:"5f",k:"5f823b13-0a49",old:"c12cb989-39a6-465b-ad3e-ce27f1753c82",now:"56816cc6-577a-400d-84ca-6d938350611c",multi:false},
  {s:"3c",k:"3cae9f09-5a52",old:"c1e7e234-5e9b-4884-aead-4baa04abf35f",now:"e191d9f4-d5c4-4f2e-8f7c-7dbfb114878a",multi:false},
  {s:"14",k:"1478a563-45e6",old:"69c3d767-1264-456a-a27f-8835feb357fc",now:"67ddbc6e-63e1-4c5d-8632-0f541e14ca8c",multi:false},
  {s:"27",k:"27aa52f5-c096",old:"e0d5e05f-0645-49e0-a0ab-667aa7690e54",now:"c9a48a51-5082-43a0-8d74-40b4111695b3",multi:false},
  {s:"45",k:"4523897c-2319",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"6a",k:"6add5373-6af7",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"9d",k:"9d3da556-fa09",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"ab",k:"ab1b63ec-5b15",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"d8",k:"d8bead3c-c6de",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"f5",k:"f56a30e7-d774",old:"4734d05a-cbce-4a7d-82cb-d298c3260879",now:"e44f1a12-0310-45f4-bd56-81ffebc7a0ae",multi:true},
  {s:"19",k:"192ea66a-76cb",old:"91c7128a-58eb-4b9d-85ad-649bd4ed29ba",now:"87efc3f9-b89e-421b-ad42-8cc1d86b6093",multi:true},
  {s:"5d",k:"5d2b6fb7-74bf",old:"91c7128a-58eb-4b9d-85ad-649bd4ed29ba",now:"87efc3f9-b89e-421b-ad42-8cc1d86b6093",multi:true},
  {s:"51",k:"51b6242d-28ab",old:"2ccb89b6-9a4f-494e-a91b-38f286b2c259",now:"3dfa6f8e-fe32-4cf1-aed6-4d7b5fa45f5c",multi:true},
  {s:"cb",k:"cb3662fa-3635",old:"2ccb89b6-9a4f-494e-a91b-38f286b2c259",now:"3dfa6f8e-fe32-4cf1-aed6-4d7b5fa45f5c",multi:true},
  {s:"54",k:"54862d36-91da",old:"ecc0cab2-9f92-48af-bdad-1751530c3d58",now:"ff38eca9-9a6d-42cc-aec0-f2f2266db45a",multi:false},
  {s:"1f",k:"1fae12f7-ba9f",old:"a7a304c4-0dd5-4c1f-916d-9c837e08eb2e",now:"3a83d3df-62e1-4d4b-917b-a4e2387ac981",multi:false},
  {s:"1c",k:"1ce12117-b86b",old:"1b077fbd-e1b4-417c-8d03-c386550352a5",now:"75c3707a-5f49-46bf-b56d-e391380b11bf",multi:true},
  {s:"3b",k:"3bd5953d-7f4a",old:"1b077fbd-e1b4-417c-8d03-c386550352a5",now:"75c3707a-5f49-46bf-b56d-e391380b11bf",multi:true},
  {s:"6b",k:"6b8e1b02-03c8",old:"1b14d314-e12c-491a-9848-1b5e7ca7af0e",now:"c328cbda-2b85-45e5-9a82-ed7a4f96edb3",multi:true},
  {s:"89",k:"890ca26a-de30",old:"1b14d314-e12c-491a-9848-1b5e7ca7af0e",now:"c328cbda-2b85-45e5-9a82-ed7a4f96edb3",multi:true},
  {s:"30",k:"30a9e0cc-417a",old:"2b0b320f-f61f-4325-9411-0909baabc781",now:"c921006c-f996-4617-af99-2a5d8049082b",multi:false},
  {s:"25",k:"2549c2a1-18fa",old:"783f6c2b-6ec0-4126-8e8e-0da5345deb7f",now:"49c6c45e-d566-4bf9-a045-4ebc39094557",multi:true},
  {s:"3f",k:"3f4c440f-381c",old:"783f6c2b-6ec0-4126-8e8e-0da5345deb7f",now:"49c6c45e-d566-4bf9-a045-4ebc39094557",multi:true},
  {s:"62",k:"62280ad2-5b89",old:"783f6c2b-6ec0-4126-8e8e-0da5345deb7f",now:"49c6c45e-d566-4bf9-a045-4ebc39094557",multi:true},
  {s:"e9",k:"e98435b2-e8dc",old:"6fd8768a-d269-494c-b9f4-7ae28d8fd9bd",now:"5903796c-a12b-4c10-b1b8-d2b8afab12ba",multi:false},
  {s:"ef",k:"ef427879-dcb1",old:"5e1e39df-432f-42bc-9a31-37ce11d1663e",now:"443aa5ef-5174-49ba-8387-c86abf11cd67",multi:false},
  {s:"92",k:"927ec5c5-8dc0",old:"2abd2870-0622-4a81-bea0-2131e96fefc8",now:"da6676ee-6d73-4fde-ae2c-18d2626b4530",multi:false},
  {s:"48",k:"4846b3b7-c4ef",old:"e14f2c3c-aa99-4a20-9afd-14cbd067fff6",now:"d95fb2ef-1538-471f-b655-e5283af3f522",multi:true},
  {s:"5d",k:"5d5cf165-ef86",old:"e14f2c3c-aa99-4a20-9afd-14cbd067fff6",now:"d95fb2ef-1538-471f-b655-e5283af3f522",multi:true},
  {s:"e5",k:"e56b1898-a88a",old:"e14f2c3c-aa99-4a20-9afd-14cbd067fff6",now:"d95fb2ef-1538-471f-b655-e5283af3f522",multi:true},
  {s:"74",k:"748ecf40-8905",old:"6a9399d0-566d-4159-8f1d-d52a580cf999",now:"153812bf-7fac-422c-b380-241409bf945c",multi:false},
  {s:"09",k:"09efae7c-43c4",old:"2ff7e1cb-8edf-43af-b135-6d014cb08b79",now:"4d033fc0-2106-497f-abef-ebe7bf54a0d0",multi:false},
  {s:"5b",k:"5b886bc5-e589",old:"bdaf2c8a-e3c6-4e40-9bc5-f233596fa255",now:"49131120-d334-4954-bc75-8c04215928e3",multi:true},
  {s:"60",k:"600977dc-949b",old:"bdaf2c8a-e3c6-4e40-9bc5-f233596fa255",now:"49131120-d334-4954-bc75-8c04215928e3",multi:true},
  {s:"7a",k:"7aebf39a-8b77",old:"bdf11304-9f1a-4889-abf3-191e82ee53a3",now:"28b5a06e-754d-4de5-b03c-25f560a59106",multi:false},
  {s:"13",k:"13c6f1ca-4205",old:"bd31d91a-2b12-4587-bbfc-acb82edd6f56",now:"ade64a31-39b8-4320-b0bd-27fa0b9451a4",multi:true},
  {s:"27",k:"27b36366-232c",old:"bd31d91a-2b12-4587-bbfc-acb82edd6f56",now:"ade64a31-39b8-4320-b0bd-27fa0b9451a4",multi:true},
  {s:"15",k:"15fe45da-c96d",old:"a1141040-689a-4730-b050-ac8c9f79b636",now:"9f350899-b196-4491-bed5-8587f54fed4a",multi:true},
  {s:"25",k:"25bbb7e6-db0a",old:"a1141040-689a-4730-b050-ac8c9f79b636",now:"9f350899-b196-4491-bed5-8587f54fed4a",multi:true},
  {s:"2a",k:"2a9a3ea2-b7f1",old:"c4d0e152-5394-4011-9cd3-bbf627df7225",now:"a09b6e59-4090-4701-bb62-b8a5b098970a",multi:false},
  {s:"e9",k:"e9b68787-ee80",old:"c4cd34ae-0d64-4bc3-8a3d-39fe6f3d8268",now:"50bd3e16-a199-44f2-90b3-225aac5b8ed7",multi:false},
  {s:"54",k:"546e1b7f-ad52",old:"0967446a-e523-47ba-8a1f-065b80af0542",now:"5cbc8e05-8772-40d5-a830-3778cace9b78",multi:true},
  {s:"7f",k:"7f3015d8-57e5",old:"0967446a-e523-47ba-8a1f-065b80af0542",now:"5cbc8e05-8772-40d5-a830-3778cace9b78",multi:true},
  {s:"af",k:"af90ed4a-7283",old:"0967446a-e523-47ba-8a1f-065b80af0542",now:"5cbc8e05-8772-40d5-a830-3778cace9b78",multi:true},
  {s:"a5",k:"a5978eea-4ece",old:"e80d02ca-d364-42b3-b670-d12de4d2d1f9",now:"186ee88f-5bc0-43c1-ae44-7bfed7f24ef9",multi:true},
  {s:"c1",k:"c11b34e6-71ae",old:"e80d02ca-d364-42b3-b670-d12de4d2d1f9",now:"186ee88f-5bc0-43c1-ae44-7bfed7f24ef9",multi:true},
  {s:"5a",k:"5a551f46-9547",old:"e8979e7f-1919-4129-8928-caf6e2c0a027",now:"58f9e7e7-6005-4943-ba77-7fdb72655c6d",multi:false},
  {s:"7d",k:"7dc8142b-ba4a",old:"1c17cfd4-a6ff-4042-9c67-efdb0f351693",now:"85598807-42a4-4515-9263-cbffd81b98d3",multi:false},
  {s:"53",k:"53f46c90-c71f",old:"be929cf5-2db8-47c5-b3fe-fce840ab6c9e",now:"abf3fb14-57e0-4ecf-8b90-dedf33030e25",multi:true},
  {s:"60",k:"6082ce53-bfe2",old:"be929cf5-2db8-47c5-b3fe-fce840ab6c9e",now:"abf3fb14-57e0-4ecf-8b90-dedf33030e25",multi:true},
  {s:"d8",k:"d845e1d3-6bd0",old:"7544b97b-a909-41c7-8d35-e5a4949b4bd8",now:"2d9da07d-2cfe-48ec-9000-164ad203c58e",multi:false},
  {s:"7b",k:"7befb365-87e9",old:"643a6bff-ced7-4730-b72e-aa448ca77e3e",now:"e61025b3-6ac6-4d06-8d26-ae6e175e8b03",multi:false},
  {s:"3c",k:"3c80ebf2-197c",old:"fc51951e-0cea-42a0-840b-21de01670219",now:"fbed1fde-ddd2-4060-abf7-6ae583d2ae55",multi:true},
  {s:"a6",k:"a6945ed7-668f",old:"fc51951e-0cea-42a0-840b-21de01670219",now:"fbed1fde-ddd2-4060-abf7-6ae583d2ae55",multi:true},
  {s:"e5",k:"e55a53e0-8dd0",old:"fc51951e-0cea-42a0-840b-21de01670219",now:"fbed1fde-ddd2-4060-abf7-6ae583d2ae55",multi:true},
  {s:"9d",k:"9dc44c75-6d0b",old:"9fe6524c-eb53-4e8b-8a4e-65fc0260a637",now:"bc9b9373-cc08-4e99-81c4-8049ed00da7f",multi:false},
  {s:"d6",k:"d6af52c1-82a8",old:"128a9244-2a33-47e7-bc41-a46f44276e34",now:"8e77dd8f-e3b2-4073-8c65-fd6f364b6362",multi:false},
  {s:"a0",k:"a06f3176-03c0",old:"e738cc65-1c22-4a21-8c35-d216b6847312",now:"3efb25e9-007a-4a36-84da-7c2fb1f632ec",multi:true},
  {s:"c1",k:"c1221778-019b",old:"e738cc65-1c22-4a21-8c35-d216b6847312",now:"3efb25e9-007a-4a36-84da-7c2fb1f632ec",multi:true},
  {s:"59",k:"590129e5-20fc",old:"c2457983-bccf-4b4d-9f49-7d3ce60b14c5",now:"d786b1fb-a82f-4afc-b5d8-fba612d06e3d",multi:true},
  {s:"77",k:"77c0035a-6e3a",old:"c2457983-bccf-4b4d-9f49-7d3ce60b14c5",now:"d786b1fb-a82f-4afc-b5d8-fba612d06e3d",multi:true},
  {s:"ae",k:"ae5ed22f-72cd",old:"c2457983-bccf-4b4d-9f49-7d3ce60b14c5",now:"d786b1fb-a82f-4afc-b5d8-fba612d06e3d",multi:true},
  {s:"23",k:"2379b807-02cd",old:"6d01b391-6a0c-418a-b050-d5aec242f58c",now:"274e1271-d0dd-494c-8bbd-0807b7898c25",multi:true},
  {s:"5a",k:"5a491985-c0a3",old:"6d01b391-6a0c-418a-b050-d5aec242f58c",now:"274e1271-d0dd-494c-8bbd-0807b7898c25",multi:true},
  {s:"da",k:"dae4db6e-6e05",old:"6d01b391-6a0c-418a-b050-d5aec242f58c",now:"274e1271-d0dd-494c-8bbd-0807b7898c25",multi:true},
  {s:"6a",k:"6acbf2f8-170d",old:"9024a193-67ee-457f-a2fc-399c5ee2b5cc",now:"cffe4021-32ec-4692-b791-c39a42dc2275",multi:false},
  {s:"ff",k:"ff253e44-ac8e",old:"9030c69c-937c-4bdb-a177-64e6e18da25d",now:"cdab8d21-8994-42f9-886b-54b392258999",multi:false},
  {s:"1a",k:"1a6a8ce9-168f",old:"01f0b939-070e-4191-ae6f-178369bc5c40",now:"c8b483ec-0fd0-4088-b380-3ae95f3ef4b7",multi:true},
  {s:"ab",k:"ab1a3558-c3e3",old:"01f0b939-070e-4191-ae6f-178369bc5c40",now:"c8b483ec-0fd0-4088-b380-3ae95f3ef4b7",multi:true},
  {s:"d6",k:"d612caa3-ee87",old:"73a7fb90-e5ea-4ab0-81d1-5c86c81c1dcd",now:"fc298d49-2d1a-4460-b622-65b411f0ecb4",multi:false},
  {s:"4e",k:"4edade86-0f06",old:"b03a6d8d-a118-4809-9931-f1062754da4f",now:"ee268bd7-c1a2-4675-a076-0dc28e587793",multi:true},
  {s:"59",k:"59e03d66-d097",old:"b03a6d8d-a118-4809-9931-f1062754da4f",now:"ee268bd7-c1a2-4675-a076-0dc28e587793",multi:true},
  {s:"e6",k:"e6e958be-7495",old:"b03a6d8d-a118-4809-9931-f1062754da4f",now:"ee268bd7-c1a2-4675-a076-0dc28e587793",multi:true},
  {s:"3e",k:"3ef55ab0-60a1",old:"b04a5309-91b6-43fc-9ff7-06efd0da16c3",now:"3935970b-149f-4538-908e-539a9814cf1e",multi:false},
  {s:"fa",k:"fa3157f3-a3c6",old:"b066e0a0-e599-42f6-bd8d-d757e476daa2",now:"2013ab8c-27b2-4709-b2b1-13a6486c4b4e",multi:false},
  {s:"20",k:"20b7995f-d708",old:"66e58ba9-b69a-461e-8c90-04d4f062d9c0",now:"7d0a572f-c843-478a-a1bf-5233b49af48f",multi:false},
  {s:"52",k:"5216bcdd-eb25",old:"d4c8048b-4150-44e5-928f-77589eb1ce1c",now:"d5ee5da0-24df-492e-afb7-16ab6035a63d",multi:false},
  {s:"19",k:"197754dd-f677",old:"fde297a4-0d9d-47af-84b5-db338f663541",now:"0b299a58-f6e8-4d11-a63c-712d92762f34",multi:false},
  {s:"5f",k:"5f7a13a8-f4c3",old:"fd77703f-9608-4239-b459-5c6042b09138",now:"beef9a8e-1a8a-4b2a-8327-96c8ca3e5001",multi:true},
  {s:"6f",k:"6f2d00bb-0419",old:"fd77703f-9608-4239-b459-5c6042b09138",now:"beef9a8e-1a8a-4b2a-8327-96c8ca3e5001",multi:true},
  {s:"f3",k:"f3c43360-211c",old:"fd77703f-9608-4239-b459-5c6042b09138",now:"beef9a8e-1a8a-4b2a-8327-96c8ca3e5001",multi:true},
  {s:"c1",k:"c1a0c949-7936",old:"aff7508c-32c6-4282-8d09-6bb7b400a31f",now:"bb7d356d-20ba-4a57-b1a2-2aa0260dd7a3",multi:true},
  {s:"c2",k:"c273e296-81bd",old:"aff7508c-32c6-4282-8d09-6bb7b400a31f",now:"bb7d356d-20ba-4a57-b1a2-2aa0260dd7a3",multi:true},
  {s:"9b",k:"9b9ffdae-3aa3",old:"055c719b-4384-4b56-be59-ab732ec9a141",now:"7532cc75-0ca8-46c1-8274-3ea54aa1d8a5",multi:false},
  {s:"16",k:"16eb811e-c0f1",old:"1833df06-450f-4ec5-8305-e5b910ae5373",now:"653fdcbc-6038-4959-aa7a-2519b536e3ea",multi:false},
  {s:"86",k:"86d2eeb3-1adb",old:"adb1c382-219b-4372-917f-903cc580f8ec",now:"769270db-9eb5-4e13-921d-6c1f291677aa",multi:false},
  {s:"64",k:"64abbf44-fda8",old:"c854420d-cf12-4a0a-96bd-231420b2fbba",now:"5c6bed8b-9257-4099-a150-cc83bd02cd54",multi:true},
  {s:"8c",k:"8c3a30cd-e333",old:"c854420d-cf12-4a0a-96bd-231420b2fbba",now:"5c6bed8b-9257-4099-a150-cc83bd02cd54",multi:true},
  {s:"34",k:"3411fc77-584f",old:"f069a6aa-af19-459e-9908-edfa6bf33a2c",now:"ade6995b-767d-4a73-910a-60b4f89b669d",multi:false},
  {s:"1a",k:"1ab64dbf-e42e",old:"3fa6cb87-be15-4f25-84d3-90e0d16c6d40",now:"b9ca8d79-1b5b-4848-acbb-b3c8db8e5cd8",multi:true},
  {s:"ed",k:"ed4de79e-80ff",old:"3fa6cb87-be15-4f25-84d3-90e0d16c6d40",now:"b9ca8d79-1b5b-4848-acbb-b3c8db8e5cd8",multi:true},
  {s:"68",k:"685aaa54-d4a5",old:"3fe55881-ef53-431f-b80b-d24436240cc1",now:"10d6ae3c-819a-4cbb-b446-08439995909d",multi:false},
  {s:"94",k:"94112beb-ba21",old:"b5fa3c2a-c5b6-486d-a081-3d7202f413d3",now:"443f46e0-03e5-4a5a-9079-a74020ce8f0c",multi:false},
  {s:"9a",k:"9abd4228-b2c4",old:"b5e49c39-c34e-402a-9669-3f0695118b44",now:"43520da5-eabd-4fc4-98f5-36b0d57a1adb",multi:false},
  {s:"3b",k:"3b9437ac-c85e",old:"243d12fc-f974-40a0-8022-9748d06cc69e",now:"6c281935-97b5-4d7f-b83f-06147f5fe827",multi:true},
  {s:"d6",k:"d64cb77b-230b",old:"243d12fc-f974-40a0-8022-9748d06cc69e",now:"6c281935-97b5-4d7f-b83f-06147f5fe827",multi:true},
  {s:"d7",k:"d7ae8bb2-59fb",old:"24730de2-8dfc-44a7-afc2-1c172738864e",now:"9a023a5c-6488-4664-b2e8-1a0826ea445c",multi:false},
  {s:"4a",k:"4a0921f5-a07d",old:"0614b05b-c357-42d4-a407-1f4bda8b80d9",now:"b81dff05-5bb3-468d-8e7e-9a0b4bda3095",multi:false},
  {s:"86",k:"868ecb7e-98b0",old:"442805d7-4682-4628-a92d-8ffd42055e9c",now:"14dc7e8f-2285-457d-8c08-ca7df38e5a7c",multi:false},
  {s:"02",k:"020fddbd-844b",old:"622098f3-be0a-4720-805f-46ddb3bc964f",now:"23fbdf5b-6f2a-4a64-9930-f0b32379823d",multi:true},
  {s:"0c",k:"0c431f03-a010",old:"622098f3-be0a-4720-805f-46ddb3bc964f",now:"23fbdf5b-6f2a-4a64-9930-f0b32379823d",multi:true},
  {s:"89",k:"89e9b839-9add",old:"622098f3-be0a-4720-805f-46ddb3bc964f",now:"23fbdf5b-6f2a-4a64-9930-f0b32379823d",multi:true},
  {s:"b6",k:"b6274cc1-7a8b",old:"fe6c2948-fff6-4997-adc6-b557eb87dbd4",now:"b2011284-c440-4d76-9174-7354e0dba8b5",multi:false},
  {s:"4f",k:"4f502ffb-1d42",old:"9e2470db-2e0a-4b05-833c-ff4fa7325d42",now:"abee7859-08be-471c-b0c1-d671164c9561",multi:false},
  {s:"40",k:"40c0677d-7c6a",old:"4e6fac5c-d273-4f0b-9071-437389167dab",now:"7d073864-bac0-4a22-9a88-923e34a67f4a",multi:false},
];

function main() {
  const want = ROWS.filter(r => SCOPE === 'all' || r.multi);
  log(`revert-alias-repoints  scope=${SCOPE}  ${want.length} of ${ROWS.length} entries${APPLY ? '' : '  (DRY RUN)'}`);
  console.log('─'.repeat(70));

  const byShard = new Map();
  for (const r of want) {
    if (!byShard.has(r.s)) byShard.set(r.s, []);
    byShard.get(r.s).push(r);
  }

  let restored = 0, alreadyOk = 0, changedSince = 0, missing = 0;
  const touched = new Set();

  for (const [shard, rs] of byShard) {
    const fp = path.join(ALIAS_DIR, `${shard}.json`);
    let obj;
    try { obj = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { log(`  SKIP shard ${shard}: ${e.message.split('\n')[0]}`); missing += rs.length; continue; }

    let changed = 0;
    for (const r of rs) {
      const cur = obj[r.k];
      if (cur === undefined)  { missing++;      log(`  MISSING  ${shard}/${r.k}`); continue; }
      if (cur === r.old)      { alreadyOk++;    continue; }          // already back
      if (cur !== r.now)      { changedSince++; log(`  LEFT ALONE ${shard}/${r.k}: holds ${cur.slice(0, 8)}, expected ${r.now.slice(0, 8)}`); continue; }
      if (APPLY) { obj[r.k] = r.old; changed++; }
      restored++;
    }
    if (APPLY && changed) { fs.writeFileSync(fp, JSON.stringify(obj), 'utf8'); touched.add(shard); }
  }

  console.log(`\n  restored${APPLY ? '' : ' (would)'} : ${restored}`);
  console.log(`  already back to the old value : ${alreadyOk}`);
  console.log(`  changed by something else, left alone : ${changedSince}`);
  console.log(`  key not present : ${missing}`);
  console.log(`  shards touched  : ${touched.size}`);

  if (!APPLY) { log('dry run - nothing written.'); return; }
  if (!touched.size) { log('nothing to write.'); return; }

  console.log('\n  \u26a0 NEXT: run Build Player Games. games[] is rebuilt from the aliases,');
  console.log('    so nothing is back in place until it does.');

  const GIT = { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60 * 1000, maxBuffer: 512 * 1024 * 1024 };
  for (const shard of touched) execSync(`git add -- players/aliases/${shard}.json`, GIT);
  const staged = execSync('git diff --staged --shortstat', GIT).toString().trim();
  if (!staged) { log('nothing staged.'); return; }
  log(`staging: ${staged}`);
  execSync(`git commit -q -m "revert-alias-repoints: restored ${restored} alias entries (scope=${SCOPE})"`, GIT);
  for (let attempt = 1; attempt <= 60; attempt++) {
    try { execSync('git merge --abort', GIT); } catch {}
    try {
      execSync('git fetch origin main', GIT);
      execSync('git merge -X ours FETCH_HEAD --no-edit --no-stat', GIT);
      execSync('git push origin main', GIT);
      log(`pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (e) {
      log(`push attempt ${attempt}/60 failed: ${e.message.split('\n')[0]}`);
      if (attempt === 60) throw new Error('push failed after 60 attempts');
      execSync(`sleep ${1 + Math.floor(Math.random() * 91)}`, { stdio: 'pipe' });
    }
  }
}

main();
