'use strict';

const util = require("util");

// enable application insights if we have an instrumentation key set up
import * as appInsights from "applicationinsights";
if (process.env.APPINSIGHTS_INSTRUMENTATIONKEY) {
  // TODO: This reads all log messages from console. We can probably do better by logging via winston/bunyan.
  appInsights.setup()
      .setAutoDependencyCorrelation(true)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setUseDiskRetryCaching(true)
      .start();
}
/** Will be `undefined` unless appInsights successfully initialized. */
const aiClient = appInsights.defaultClient;
// aiClient.addTelemetryProcessor((envelope, context) => {
//   envelope.data.
//   return true;
// });

import Discord from 'discord.js';
import { RollemParser } from '../rollem-language/rollem.js';
import moment from 'moment';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import * as assert from 'assert';

const mongodbAddress = process.env.MONGODB_ADDRESS as string;
const mongodbPassword = process.env.MONGODB_ROOT_PASSWORD as string;
assert.ok(!!mongodbAddress, "no mongodb address");
assert.ok(!!mongodbPassword, "no mongodb password");

MongoClient.connect(
  mongodbAddress,
  { auth: { user: 'root', password: mongodbPassword } },
  (err, client) => {
    assert.equal(null, err);
    
    console.log("Mongo DB connection successful.");
 
    const db = client.db("test");
   
    client.close();
  })

let rollemParser = new RollemParser();
let VERSION = "v1.x.x";

let client = new Discord.Client({});

var token = process.env.DISCORD_BOT_USER_TOKEN;
console.log("Logging in using token1: " + token);
var deferToClientIds = (process.env.DEFER_TO_CLIENT_IDS || '').split(',');

// read the changelog to the last major section that will fit
const CHANGELOG_LINK = "<https://github.com/lemtzas/rollem-discord/blob/master/CHANGELOG.md>\n\n";
var changelog = CHANGELOG_LINK + "(Sorry, we're still reading it from disk.)";
fs.readFile("./CHANGELOG.md", 'utf8', (err, data) => {
  const MAX_LENGTH = 2000 - CHANGELOG_LINK.length;
  const MAX_LINES = 15;
  // error handling
  if (err) {
    console.error(err);
    changelog = CHANGELOG_LINK + "(Sorry, there was an issue reading the file fom disk.) \n\n" + err;
    return;
  }

  // don't go over the max discord message length
  let maxLengthChangelog = data.substring(0, MAX_LENGTH);

  // don't go over a reasonable number of lines
  let reasonableLengthChangeLog = maxLengthChangelog.split("\n").slice(0, MAX_LINES).join("\n");

  // don't show partial sections
  let lastSectionIndex = reasonableLengthChangeLog.lastIndexOf("\n#");
  let noPartialSectionsChangeLog = reasonableLengthChangeLog.substring(0, lastSectionIndex);

  // set the changelog
  changelog = CHANGELOG_LINK + noPartialSectionsChangeLog

  // set the version
  let firstLine = data.substring(0, data.indexOf("\n"));
  let versionMatch = firstLine.match(/\d+(?:\.\d+){2}/i);
  let versionText = versionMatch ? versionMatch[0] : null;
  if (versionText) {
    VERSION = `v${versionText}`;
    cycleMessage();
  }
});

var mentionRegex = /$<@999999999999999999>/i;
var messageInterval = 60 * 1000; // every minute
var messages = [
  () => `${VERSION} - http://rollem.rocks`
];

function cycleMessage() {
  if (client.user) {
    let messageFunc = messages.shift();
    if (!messageFunc) {
      throw new Error("No message found.");
    }

    messages.push(messageFunc);
    let message = messageFunc();
    client.user.setStatus("online").catch(error => handleRejection("setStatus", error));
    client.user
      .setActivity(message)
      .catch(error => handleRejection("setActivity", error));
  }
}

client.on('disconnect', (f) => {
  trackEvent("disconnect", { reason: util.inspect(f) });
  if (aiClient) { aiClient.flush(); }
  process.exit(1);
});

client.on('error', (error) => {
  if (error && typeof(error.message) === "string") {
    try {
      let ignoreError = error.message.includes('write EPIPE');
      if (ignoreError) {
        trackEvent("known error - " + error.message, { reason: util.inspect(error)});
        return;
      }
    } catch { }
  }

  trackEvent("unknown error", { reason: util.inspect(error) });
  if (aiClient) { aiClient.flush(); }

  process.exit(1);
});

client.on('ready', () => {
  trackEvent("ready");

  console.log('I am ready!');
  cycleMessage();

  console.log("will defer to " + deferToClientIds);
  console.log('username: ' + client.user.username);
  console.log('id: ' + client.user.id);

  setInterval(cycleMessage, messageInterval);
  var mentionRegex_s = '^<@' + client.user.id + '>\\s+';
  mentionRegex = new RegExp(mentionRegex_s);

  sendHeartbeat("startup message");
  sendHeartbeatNextHour();
});

function sendHeartbeatNextHour() {
  const now = moment();
  const nextHour = moment().endOf('h');
  const msToNextHour = nextHour.diff(now);
  setTimeout(
    () => {
      sendHeartbeat("heartbeat at " + nextHour.toString());
      sendHeartbeatNextHour();
    },
    msToNextHour
  );
}

/** Sends a single heartbeat-info message to owner confirming liveliness. */
function sendHeartbeat(reason: string) {
  const disableHeartbeat = process.env.DISABLE_HEARTBEAT
  if (disableHeartbeat) { return; }

  trackEvent(`heartbeat - shard ${shardName()}`, {reason: reason});
}

// ping pong in PMs
client.on('message', message => {
  if (message.author.bot) { return; }
  if (message.author == client.user) { return; }
  if (message.guild) { return; }

  if (message.content === 'ping') {
    message.reply('pong').catch(rejected => handleSendRejection(message));
  }
});

// stats and help
client.on('message', message => {
  if (message.author.bot) { return; }
  let content = message.content;

  // ignore without prefix
  var match = content.match(mentionRegex);
  if (message.guild && !match) { return; }
  if (match) {
    content = content.substring(match[0].length).trim();
  }

  // stats and basic help
  if (content.startsWith('stats') || content.startsWith('help')) {
    let guilds = client.guilds.map((g) => g.name);
    let uptime = moment.duration(client.uptime);
    let stats = [
      '',
      `**shard:** ${shardName()}`,
      `**uptime:** ${uptime.days()}d ${uptime.hours()}h ${uptime.minutes()}m ${uptime.seconds()}s`,
      `**servers:** ${client.guilds.size}`,
      `**users:** ${client.users.size}`,
      '',
      'Docs at <http://rollem.rocks>',
      'Try `@rollem changelog`',
      '',
      'Avatar by Kagura on Charisma Bonus.'
    ];
    let response = stats.join('\n');
    message.reply(stats).catch(rejected => handleSendRejection(message));
    trackEvent("stats");
  }

  // changelog
  if (content.startsWith('changelog') ||
    content.startsWith('change log') ||
    content.startsWith('changes') ||
    content.startsWith('diff')) {
    message.reply(changelog).catch(rejected => handleSendRejection(message));
    trackEvent("changelog");
  }
});

// greedy rolling
client.on('message', message => {
  // avoid doing insane things
  if (message.author.bot) { return; }
  if (message.author == client.user) { return; }
  if (shouldDefer(message)) { return; }
  if (message.content.startsWith('D')) { return; } // apparently D8 is a common emote.

  // honor the prefix
  let prefix = getPrefix(message);
  if (!message.content.startsWith(prefix)) { return; }

  // get our actual roll content
  let content = message.content.substring(prefix.length);
  content = content.trim();

  let count = 1;
  let match = content.match(/(?:(\d+)#\s*)?(.*)/);
  let countRaw = match ? match[1] : false;
  if (countRaw) {
    count = parseInt(countRaw);
    if (count > 100) { return; }
    if (count < 1) { return; }
  }

  count = count || 1;
  let contentAfterCount = match ? match[2] : content;

  var lines: string[] = [];
  for (let i = 0; i < count; i++) {
    var result = rollemParser.tryParse(contentAfterCount);
    if (!result) { return; }

    let shouldReply = prefix || (result.depth > 1 && result.dice > 0); // don't be too aggressive with the replies
    if (!shouldReply) { return; }

    let response = buildMessage(result);

    if (response && shouldReply) {
      lines.push(response);
    }
  }

  if (lines.length > 0) {
    let response = "\n" + lines.join("\n");
    message.reply(response).catch(rejected => handleSendRejection(message));

    if (count === 1) { trackEvent('soft parse'); }
    else { trackEvent('soft parse, repeated'); }

    return;
  }
});

// TODO: Split this up. Combine common bail rules.
// inline and convenience messaging
client.on('message', message => {
  // avoid doing insane things
  if (message.author.bot) { return; }
  if (message.author == client.user) { return; }
  if (shouldDefer(message)) { return; }

  var content = message.content.trim();

  // ignore the dice requirement with prefixed strings
  if (content.startsWith('r') || content.startsWith('&')) {
    var subMessage = content.substring(1);
    var result = rollemParser.tryParse(subMessage);
    var response = buildMessage(result, false);
    if (response) {
      if (shouldDefer(message)) { return; }
      message.reply(response).catch(rejected => handleSendRejection(message));
      trackEvent('medium parse');
      return;
    }
  }

  // ignore the dice requirement with name prefixed strings
  var match = content.match(mentionRegex); // TODO: This should override Deferral
  if (match) {
    var subMessage = content.substring(match[0].length);
    var result = rollemParser.tryParse(subMessage);
    var response = buildMessage(result, false);
    if (response) {
      if (shouldDefer(message)) { return; }
      message.reply(response).catch(rejected => handleSendRejection(message));
      trackEvent('hard parse');
      return;
    }
  }

  // handle inline matches
  let last: RegExpExecArray | null = null;
  var matches: string[] = [];
  var regex = /\[(.+?)\]/g;
  while (last = regex.exec(content)) { matches.push(last[1]); }

  if (matches && matches.length > 0) {
    var messages = matches.map(function (match) {
      var result = rollemParser.tryParse(match);
      var response = buildMessage(result);
      return response;
    }).filter(x => !!x);

    if (messages.length === 0) { return; }

    var fullMessage = '\n' + messages.join('\n');
    if (fullMessage) {
      if (shouldDefer(message)) { return; }
      message.reply(fullMessage).catch(rejected => handleSendRejection(message));
      trackEvent('inline parse');
      return;
    }
  }
});

function getRelevantRoleNames(message: Discord.Message, prefix: string) {
  if (!message.guild) { return []; }
  let me = message.guild.members.get(client.user.id);
  if (!me) { return []; }
  let roleNames = me.roles.map(r => r.name);
  let roles = roleNames.filter(rn => rn.startsWith(prefix));
  return roles;
}

function getPrefix(message: Discord.Message) {
  let prefixRolePrefix = 'rollem:prefix:';
  let prefixRoles = getRelevantRoleNames(message, prefixRolePrefix);
  if (prefixRoles.length == 0) { return ""; }
  let prefix = prefixRoles[0].substring(prefixRolePrefix.length);
  return prefix;
}

function shouldDefer(message: Discord.Message) {
  if (!message.guild) { return false; }
  if (!message.channel) { return false; }
  if (!(message.channel instanceof Discord.TextChannel)) { return false; }

  let members = message.channel && message.channel.members;
  if (!members) { return false; }

  let deferToMembers =
    deferToClientIds.filter(id => {
      let member = members.get(id);
      let isOnline = member && member.presence && member.presence.status == 'online';
      return isOnline;
    }).map(id => members.get(id) as Discord.GuildMember);

  if (deferToMembers.length > 0) {
    let names = deferToMembers.map(member => `${member.user.username} (${member.user.id})`).join(", ");
    trackEvent('deferral to ' + names);
    return true;
  }

  return false;
}

// TODO: Handle response type of rollem parser
function buildMessage(result: any, requireDice = true) {
  if (result === false) { return false; }
  if (typeof (result) === "string") { return result; }
  if (result.depth <= 1) { return false; }
  if (requireDice && result.dice < 1) { return false; }

  var response = "";

  if (result.label && result.label != "") {
    response += "'" + result.label + "', ";
  }
  if (typeof (result.value) === "boolean") {
    result.value = result.value ? "**Success!**" : "**Failure!**";
  }

  response += result.value + ' ⟵ ' + result.pretties;

  return response;
}

/** Constructs a human-readable string identifying this shard. */
function shardName() {
  return client.shard
    ? `${client.shard.id+1} of ${client.shard.count}`
    : "only";
}

/** Constructs a one-index string identifying this shard. */
function shardId() {
  return client.shard
    ? client.shard.id + 1
    : 1;
}

/** Safely retrieves the shard count. */
function shardCount() {
  return client.shard
    ? client.shard.count
    : 1;
}

/** Adds common AI properties to the given object (or creates one). Returns the given object. */
function enrichAIProperties(object = {}) {
  object["Shard Name"] = ''+shardName();
  object["Client ID"] = ''+client.user.id;
  object["Client Name"] = ''+client.user.username;
  object["Version"] = ''+VERSION;
  return object;
}

/** Adds common AI metrics to the given object (or creates one). Returns the given object. */
function enrichAIMetrics(object = {}) {
  object['Servers (per shard)'] = client.guilds.size;
  object['Users (per shard)'] = client.users.size;
  object['Uptime (minutes)'] = client.uptime / 1000 / 60;
  object['Shard Count'] = shardCount();
  object['Shard ID'] = shardId();
  return object;
}

/** Tracks an event with AI using a console fallback. */
// TODO: Convert many of the operations to use trackRequest instead. See https://docs.microsoft.com/en-us/azure/application-insights/app-insights-api-custom-events-metrics#trackrequest
function trackEvent(name: string, properties = {}) {
  if (aiClient) {
    aiClient.trackEvent({
      name: name,
      measurements: enrichAIMetrics(),
      properties: enrichAIProperties(properties)
    });
  } else {
    console.log(name, properties);
  }
}

/** Tracks a metric with AI using a console fallback. */
function trackMetric(name: string, value: number) {
  if (aiClient) {
    aiClient.trackMetric({
      name: name,
      value: value
    });
  } else {
    // oblivion
  }
}

function handleRejection(label, error) {
  // let guildId = message.guild ? message.guild.id : null;
  // let channelId = message.channel ? message.channel.id : null;
  // let messageId = message.id;
  // let userId = message.userId;
  if (aiClient) {
    aiClient.trackException({
      exception: error,
      properties: {
        error: util.inspect(error),
        label: label,
      }
    });
  }
}

function handleSendRejection(message) {
  // let guildId = message.guild ? message.guild.id : null;
  // let channelId = message.channel ? message.channel.id : null;
  // let messageId = message.id;
  // let userId = message.userId;
  trackEvent("Missing send permission");
}

console.log("Logging in using token2: " + token);
client.login(token);