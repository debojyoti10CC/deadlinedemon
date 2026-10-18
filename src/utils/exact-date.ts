import { DateTime } from 'luxon';

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/** Correct only common, unambiguous tomorrow spellings; retain original owner text elsewhere. */
export function normalizeDateWords(value: string): string {
 return value.replace(/\b(?:tommorow|tommorrow|tomorow)\b/gi,'tomorrow')
  .replace(/([ap]m)(?=\d)/gi,'$1 ')
  .replace(new RegExp(`(${MONTHS})(?=\\d)`,'gi'),'$1 ');
}

/** Parse one fully explicit date and clock. Unknown words or multiple deadlines defer to interpretation. */
export function exactLocalDeadline(value:string,timezone:string,reference:Date):string|null {
 let rest=normalizeDateWords(value).trim();
 if(/\b(?:around|approximately|roughly|between|or|sometime|maybe)\b|\bish\b/i.test(rest))return null;
 const now=DateTime.fromJSDate(reference,{zone:timezone});
 if(!now.isValid)return null;
 const days:Array<{year:number;month:number;day:number}>=[];
 rest=rest.replace(/\b(\d{4})-(\d{2})-(\d{2})(?=T|\b)/g,(_whole,y,m,d)=>{
  days.push({year:Number(y),month:Number(m),day:Number(d)});return ' ';
 }).replace(/\bT(?=\d)/g,' ');
 rest=rest.replace(/\b(today|tonight|tomorrow)\b/gi,(_whole,word)=>{
  const day=now.plus({days:word.toLowerCase()==='tomorrow'?1:0});
  days.push({year:day.year,month:day.month,day:day.day});return ' ';
 });
 const addNamed=(month:string,day:string,year?:string)=>{
  const m=MONTH_KEYS.indexOf(month.slice(0,3).toLowerCase())+1;const d=Number(day);
  const y=year?Number(year):now.year+(m<now.month||(m===now.month&&d<now.day)?1:0);
  days.push({year:y,month:m,day:d});
 };
 const dayFirst=new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${MONTHS})(?:,?\\s+(\\d{4}))?(?![a-z])`,'gi');
 rest=rest.replace(dayFirst,(_whole,d,m,y)=>{addNamed(m,d,y);return ' ';});
 const monthFirst=new RegExp(`\\b(${MONTHS})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)`,'gi');
 rest=rest.replace(monthFirst,(_whole,m,d,y)=>{addNamed(m,d,y);return ' ';});
 const clocks:Array<{hour:number;minute:number;second:number}>=[];
 rest=rest.replace(/\b(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?m\.?(?![a-z])/gi,(_whole,h,m,ap)=>{
  clocks.push({hour:Number(h)%12+(ap.toLowerCase()==='p'?12:0),minute:Number(m??0),second:0});return ' ';
 });
 rest=rest.replace(/\b(noon|midnight)\b/gi,(_whole,word)=>{
  clocks.push({hour:word.toLowerCase()==='noon'?12:0,minute:0,second:0});return ' ';
 });
 rest=rest.replace(/\b([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g,(_whole,h,m,s)=>{
  clocks.push({hour:Number(h),minute:Number(m),second:Number(s??0)});return ' ';
 });
 const uniqueDays=[...new Map(days.map(day=>[JSON.stringify(day),day])).values()];
 const uniqueClocks=[...new Map(clocks.map(clock=>[JSON.stringify(clock),clock])).values()];
 // Do not infer missing dates, missing meridiems, timezones, or additional tasks.
 rest=rest.replace(/\b(?:at|on|by|before|the|of)\b/gi,' ').replace(/[\s,.!?;:()"“”'’\-]/g,'');
 if(rest||uniqueDays.length!==1||uniqueClocks.length!==1)return null;
 const parts={...uniqueDays[0]!,...uniqueClocks[0]!};
 const result=DateTime.fromObject(parts,{zone:timezone});
 if(!result.isValid||result.year!==parts.year||result.month!==parts.month||result.day!==parts.day||result.hour!==parts.hour)return null;
 return result.toFormat(result.second?"yyyy-MM-dd'T'HH:mm:ss":"yyyy-MM-dd'T'HH:mm");
}
