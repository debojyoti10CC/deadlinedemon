import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { DateTime } from 'luxon';
import type { Agent, Intent, IntentContext, Intensity } from '../types.js';
import { isValidTimezone, parseDeadline } from '../utils/dates.js';
import { exactLocalDeadline, normalizeDateWords } from '../utils/exact-date.js';
import { IntentSchema, MessageSchema } from './schemas.js';
import { boundedContext, PERSONALITY } from './personality.js';
import { EVIDENCE_RULES, INTENT_PROMPT } from './prompts.js';
import { parseCommand } from './commands.js';
export { parseCommand } from './commands.js';

function emptyIntent(intent: Intent['intent'], values: Partial<Intent> = {}): Intent {
  return {
    intent, title: null, artifact_url: null, deadline_local: null, timezone: null,
    intensity: null, contract_id: null, needs_clarification: false, clarification: null,
    ...values,
  };
}

function clarification(message: string): Intent {
  return emptyIntent('unknown', { needs_clarification: true, clarification: message });
}

function sameTimezone(left: string, right: string): boolean {
  if (!isValidTimezone(left) || !isValidTimezone(right)) return false;
  try {
    const canonical = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    return canonical(left) === canonical(right);
  } catch { return false; }
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60,
};

/** A date acknowledgement can continue only the immediately preceding clarification thread. */
function dateAcknowledgement(text:string):boolean {
  return /^(?:yes|yep|yeah|correct|confirmed|that is correct|that's correct)[.!]*$/i.test(text.trim());
}

function clarificationOwners(latest: string, context: IntentContext, dateReply=false): string[] | null {
  if (!dateReply&&!dateAcknowledgement(latest)) return null;
  const history = context.history.slice(-12);
  const isDeadlineQuestion = (content: string): boolean =>
    !/^\s*(?:status|reminder|pending|task|contract|completion recorded)\b/i.test(content) &&
    !/\b(?:send|receive|remind|notify)\b[^?]*\b(?:status|reminder|update|notification|check-in)\b/i.test(content) &&
    /\b(?:date|time|deadline|midnight|[ap]\.?m\.?)\b/i.test(content) &&
    /\b(?:what|which)\s+(?:exact|future|specific)\s+(?:date|time|deadline)\b|\b(?:what|which)\s+(?:date(?:\s+and\s+time)?|time|deadline)\b[^?]*\bshould I (?:use|set)\b|\b(?:do|did) you mean\b|\b(?:confirm|provide)\s+(?:the\s+)?(?:exact\s+)?(?:date|time|deadline)\b/i.test(content) &&
    !/\bCONFIRM\s+[0-9a-f-]{36}\b/i.test(content);
  const previous = history.at(-1);
  if (previous?.role !== 'assistant' || !isDeadlineQuestion(previous.content)) return null;
  const owners: string[] = [];
  for (const message of [...history].reverse()) {
    if (message.role === 'assistant') {
      if (!isDeadlineQuestion(message.content)) break;
    } else owners.push(message.content.slice(0, 1500));
  }
  return owners;
}

function simpleTaskParts(text:string):{title:string;deadline:string}|null {
  if(/https?:\/\/|\b(?:mild|savage|nuclear|github|PR|pull request)\b/i.test(text))return null;
  const clean=text.trim().replace(/^(?:I\s+(?:need|want|have|plan)\s+to\s+|please\s+)/i,'')
    .replace(/(?:[,;]\s*|\s+)(?:(?:and\s+)?(?:please\s+)?add|and\s+at)\s+(?:that|this|it)\s+as\s+a\s+task[.!]?$/i,'');
  // Start at the first temporal clause. Multiple deadlines or extra commands
  // remain in the deadline text and defer to interpretation rather than merging tasks.
  const match=/^((?:finish|complete|submit|ship|write|study|read|edit|record|design|build|practice|prepare|exercise|work on|pay|buy|clean)\b.{1,220}?)\s+(?:by|before|at|on)\s+(.+)$/i.exec(clean);
  return match?{title:match[1]!.trim(),deadline:match[2]!.trim()}:null;
}

/** Complete ordinary task messages and scoped date replies need no model calendar. */
function simpleOrdinaryTask(text:string,context:IntentContext):Intent|null {
  const now=new Date(context.now);
  const direct=simpleTaskParts(text);
  let title=direct?.title;
  let local=direct?exactLocalDeadline(direct.deadline,context.timezone,now):null;
  if(!direct){
    const owners=clarificationOwners(text,context,true);
    if(!owners)return null;
    let latestOwnerDeadline:string|null=null;
    for(const owner of owners){
      if(dateAcknowledgement(owner))continue;
      const reference=context.history.findLast(message=>message.role==='user'&&message.content===owner)?.created_at??now;
      const task=simpleTaskParts(owner);
      if(task){
        title=task.title;
        latestOwnerDeadline??=exactLocalDeadline(task.deadline,context.timezone,reference);
        break;
      }
      const candidate=exactLocalDeadline(owner,context.timezone,reference);
      // A changed task or an unparsed correction ends native recovery. Never
      // skip it and silently reuse an older title or rejected deadline.
      if(!candidate)return null;
      latestOwnerDeadline??=candidate;
    }
    if(!title)return null;
    local=exactLocalDeadline(text,context.timezone,now);
    if(!local&&dateAcknowledgement(text))local=latestOwnerDeadline;
  }
  if(!title||!local)return null;
  try{parseDeadline(local,context.timezone,now);}
  catch{return clarification(`That deadline has passed or is invalid. What future date and time should I use for ${title}?`);}
  return emptyIntent('create_contract',{title:title.slice(0,200),deadline_local:local,timezone:context.timezone,milestones:null});
}

/** Require real owner wording for both temporal components before trusting extraction. */
function groundedDeadline(sources: string[] | null, latest: string, context: IntentContext, deadline: Date): boolean {
  const continuation = clarificationOwners(latest, context);
  if (!sources?.length || (!continuation && !sources.some(source => latest.includes(source)))) return false;
  const ownerMessages = [latest, ...(continuation ?? context.history.slice(-12).filter(item => item.role === 'user').map(item => item.content.slice(0, 1500)))];
  if (sources.some(source => !ownerMessages.some(message => message.includes(source)))) return false;
  const source = normalizeDateWords(sources.join(' '));
  if (/\b(?:sometime|whenever|maybe|around|approximately|roughly|between|or)\b|\bish\b/i.test(source)) return false;
  const local = DateTime.fromJSDate(deadline, { zone: context.timezone });
  const relativeSource=sources.find(item=>/\b(today|tonight|tomorrow)\b/i.test(normalizeDateWords(item)));
  const previousOwner=relativeSource&&!latest.includes(relativeSource)?context.history.findLast(item=>item.role==='user'&&item.content.includes(relativeSource)):undefined;
  const now = DateTime.fromJSDate(previousOwner?.created_at??new Date(context.now), { zone: context.timezone });
  const duration = /\bin\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\s+(minutes?|hours?|days?)\b/i.exec(source);
  if (duration) {
    const count = NUMBER_WORDS[duration[1]!.toLowerCase()] ?? Number(duration[1]);
    const unit = duration[2]!.toLowerCase().startsWith('minute') ? 60_000 : duration[2]!.toLowerCase().startsWith('hour') ? 3_600_000 : 86_400_000;
    return count > 0 && Math.abs(deadline.getTime() - (new Date(context.now).getTime() + count * unit)) < 1000;
  }
  const isoDates = [...source.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  const relativeDates = [...source.matchAll(/\b(today|tonight|tomorrow)\b/gi)];
  const weekdays = [...source.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)];
  const dayFirst=[...source.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s+(\d{4}))?\b/gi)];
  const namedDates = [...source.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi),...dayFirst.map(match=>[match[0],match[2],match[1],match[3]])];
  if (!isoDates.length && !relativeDates.length && !weekdays.length && !namedDates.length) return false;
  // Broad snippets may share one date across several clocks, but cannot mix dates.
  if (isoDates.some(date => date[0] !== local.toISODate())) return false;
  if (relativeDates.some(date => now.plus({ days: date[1]!.toLowerCase() === 'tomorrow' ? 1 : 0 }).toISODate() !== local.toISODate())) return false;
  if (weekdays.some(day => local.toFormat('cccc').toLowerCase() !== day[1]!.toLowerCase() || local.startOf('day').diff(now.startOf('day'), 'days').days > 7)) return false;
  for (const namedDate of namedDates) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(namedDate[1]!.slice(0, 3).toLowerCase()) + 1;
    if (local.month !== month || local.day !== Number(namedDate[2])) return false;
    if (namedDate[3] && local.year !== Number(namedDate[3])) return false;
    if (!namedDate[3]) {
      let expected = local.set({ year: now.year });
      if (expected.toMillis() <= now.toMillis()) expected = expected.plus({ years: 1 });
      if (local.year !== expected.year) return false;
    }
  }
  const meridiemClock = /\b(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?m\.?(?!\w)/gi;
  const clocks = [...source.matchAll(meridiemClock)].map(clock => ({
    hour: Number(clock[1]) % 12 + (clock[3]!.toLowerCase() === 'p' ? 12 : 0),
    minute: Number(clock[2] ?? 0), second: 0,
  }));
  if (/\bnoon\b/i.test(source)) clocks.push({ hour: 12, minute: 0, second: 0 });
  if (/\bmidnight\b/i.test(source)) clocks.push({ hour: 0, minute: 0, second: 0 });
  // Remove AM/PM clocks first so 08:00 PM cannot also authorize 08:00 AM.
  const withoutMeridiem = source.replace(meridiemClock, ' ');
  const clock24 = [...withoutMeridiem.matchAll(/\d{4}-\d{2}-\d{2}T([0-2]\d):([0-5]\d)(?::([0-5]\d))?/g),
    ...withoutMeridiem.matchAll(/\b(0\d|1[3-9]|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g)];
  clocks.push(...clock24.map(clock => ({ hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0) })));
  return clocks.some(clock => local.hour === clock.hour && local.minute === clock.minute && local.second === clock.second);
}

export class OpenAIAgent implements Agent {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    if (!apiKey.trim() || !model.trim()) throw new Error('OpenAI API key and model are required.');
    this.client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
  }

  async parse(text: string, context: IntentContext): Promise<Intent> {
    const command = parseCommand(text, context.contracts, context.selected_contract_id ?? null);
    if (command) return command;
    if (!text.trim()) return clarification('Tell me the task and an exact deadline. A GitHub issue or PR link is optional.');
    if (text.length > 8000) return clarification('Please shorten your message to 8000 characters or fewer.');
    if (!Number.isFinite(new Date(context.now).getTime()) || !sameTimezone(context.timezone, context.timezone)) {
      throw new Error('Intent context requires the real current time and a valid stored timezone.');
    }
    const ordinary=simpleOrdinaryTask(text,context);
    if(ordinary)return ordinary;
    const response = await this.client.responses.parse({
      model: this.model,
      ...(this.model === 'gpt-6-luna' ? { reasoning: { effort: 'none' as const } } : {}),
      instructions: INTENT_PROMPT,
      input: JSON.stringify({
        now: context.now, stored_timezone: context.timezone, current_intensity: context.intensity,
        selected_contract_id: context.contracts.some(contract => contract.id === context.selected_contract_id) ? context.selected_contract_id : null,
        answering_deadline_clarification: clarificationOwners(text, context) !== null,
        contracts: context.contracts.slice(0, 20).map(contract => ({
          id: contract.id, display_id: contract.display_id, title: contract.title.slice(0, 240), state: contract.state,
          due_at: contract.due_at.toISOString(), artifact_url: contract.artifact_url,
        })),
        history: context.history.slice(-12).map(message => ({ role: message.role, content: message.content.slice(0, 1500), created_at: message.created_at?.toISOString() })),
        latest_message: text,
      }),
      text: { format: zodTextFormat(IntentSchema, 'deadline_demon_intent') },
      store: false,
      max_output_tokens: 1600,
    });
    if (response.status !== 'completed' || !response.output_parsed) {
      throw new Error('OpenAI did not return a complete validated intent. No action was authorized.');
    }
    const { deadline_sources: deadlineSources, milestones, ...extracted } = IntentSchema.parse(response.output_parsed);
    const result: Intent = { ...extracted, milestones: milestones?.map(({ title, deadline_local }) => ({ title, deadline_local })) ?? null };
    if (result.needs_clarification) {
      result.clarification ||= 'Please provide the missing or ambiguous commitment details.';
      return result;
    }
    if (result.intent === 'create_contract') {
      if ((!milestones && (!result.title?.trim() || !result.deadline_local?.trim())) || milestones?.some(m => !m.title.trim())) {
        return { ...result, needs_clarification: true,
          clarification: 'What is the task and its exact date and deadline with AM/PM in your stored timezone?' };
      }
      if (milestones && result.artifact_url) {
        return { ...result, needs_clarification: true, clarification: 'Use one deadline per GitHub target, or send ordinary tasks with their separate deadlines.' };
      }
      if (result.timezone !== null && !sameTimezone(result.timezone, context.timezone)) {
        return { ...result, timezone: context.timezone, deadline_local: null, needs_clarification: true,
          clarification: `Your stored timezone is ${context.timezone}. What exact date and time should I use in that timezone?` };
      }
      result.timezone = context.timezone;
      try {
        const proposals = milestones ?? [{ title: result.title!, deadline_local: result.deadline_local!, deadline_sources: deadlineSources }];
        for (const proposal of proposals) {
          const deadline = parseDeadline(proposal.deadline_local, context.timezone, new Date(context.now));
          if (!groundedDeadline(proposal.deadline_sources, text, context, deadline)) {
            return { ...result, deadline_local: null, milestones: null, needs_clarification: true,
              clarification: `What exact date and time (with AM/PM or a clear 24-hour time) should I use for ${proposal.title} in ${context.timezone}?` };
          }
        }
      }
      catch (error) {
        return { ...result, deadline_local: null, milestones: null, needs_clarification: true,
          clarification: error instanceof Error ? error.message : 'Please give an unambiguous future date and time.' };
      }
    } else {
      // An extraction never changes a saved owner timezone, including unrelated intents.
      result.timezone = null;
      result.milestones = null;
    }
    if (result.contract_id && !context.contracts.some(contract => contract.id === result.contract_id)) {
      return { ...result, contract_id: null, needs_clarification: true, clarification: 'Which task do you mean? Send LIST, then use its task number.' };
    }
    if (result.intent === 'change_intensity' && result.intensity === null) {
      return { ...result, needs_clarification: true, clarification: 'Choose mild, savage, or nuclear.' };
    }
    result.clarification = null;
    return result;
  }

  async generate(event: string, context: Record<string, unknown>, intensity: Intensity): Promise<string> {
    const payload = JSON.stringify({ event: event.slice(0, 100), facts: boundedContext(context) });
    if (payload.length > 60_000) throw new Error('Evidence context is too large to generate a reliable message.');
    const response = await this.client.responses.parse({
      model: this.model,
      ...(this.model === 'gpt-6-luna' ? { reasoning: { effort: 'none' as const } } : {}),
      instructions: `${EVIDENCE_RULES}\nTone: ${PERSONALITY[intensity]}`,
      input: payload,
      text: { format: zodTextFormat(MessageSchema, 'deadline_demon_message') },
      store: false,
      max_output_tokens: 1600,
    });
    if (response.status !== 'completed' || !response.output_parsed) {
      throw new Error('OpenAI did not return a complete validated message. No message was generated.');
    }
    const message = MessageSchema.parse(response.output_parsed).message.trim();
    if (!message) throw new Error('OpenAI returned an empty message.');
    return message;
  }
}
