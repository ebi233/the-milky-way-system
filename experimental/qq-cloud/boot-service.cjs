'use strict';
const fs=require('fs'),path=require('path');
const original=JSON.parse(fs.readFileSync(path.join(__dirname,'paopao-original-main.json'),'utf8'));
require(path.resolve(__dirname,original.main));
require('/home/qq/lab/service.cjs')(require);
