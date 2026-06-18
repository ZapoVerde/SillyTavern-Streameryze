/**
 * @file st-extensions/SillyTavern-Triggeryze/triggers.js
 * @stamp {"utc":"2026-06-16T00:00:00.000Z"}
 * @architectural-role Registry — TRIGGER_REGISTRY assembler
 * @description
 * Assembles TRIGGER_REGISTRY from the individual trigger entry modules in triggers/.
 * Contains no trigger implementation logic. Adding a new trigger type means adding an
 * entry file in triggers/ and importing it here — no other files need changing.
 *
 * @api-declaration
 * TRIGGER_REGISTRY — map of type key → trigger definition
 *
 * @contract
 *   assertions:
 *     purity:          pure import/export; no logic
 *     state_ownership: none
 *     external_io:     none
 */

import { keywordTrigger }   from './triggers/keyword.js';
import { eventTrigger }     from './triggers/event.js';
import { badgeTrigger }     from './triggers/badge.js';
import { conditionTrigger } from './triggers/condition.js';
import { varMatchTrigger }  from './triggers/varMatch.js';
import { chanceTrigger }    from './triggers/chance.js';
import { domEventTrigger }  from './triggers/domEvent.js';

export const TRIGGER_REGISTRY = {
    keyword:   keywordTrigger,
    event:     eventTrigger,
    badge:     badgeTrigger,
    condition: conditionTrigger,
    varMatch:  varMatchTrigger,
    chance:    chanceTrigger,
    domEvent:  domEventTrigger,
};
