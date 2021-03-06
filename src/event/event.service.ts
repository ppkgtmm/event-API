import { Injectable } from '@nestjs/common';
import { Interval } from '../shared/enums';
import {
  badRequestExceptionThrower,
  getMonthDays,
  isLeapYear,
} from '../shared/functions';
import { getConnection, ObjectLiteral } from 'typeorm';
import { Event } from '../schemas/event.entity';
import { EventDTO, GetEventDTO } from '../shared/dtos';
import { DAYSINWEEK, OFFSET, SECINDAY } from '../shared/constants';

@Injectable()
export class EventService {
  // returns date for specified time offset
  static getPackedDate(event: EventDTO | GetEventDTO) {
    const timeStamp = new Date(
      `${event.year}-${event.month}-${event.date} ${OFFSET}`,
    );
    return timeStamp;
  }

  // ensures that date is a valid date for corresponding month
  static validateMonthDate(event: EventDTO | GetEventDTO) {
    const { date, month, year } = event;
    const maxDate = getMonthDays(isLeapYear(year), month);
    badRequestExceptionThrower(
      date > maxDate,
      `Invalid date for month ${month}`,
    );
  }

  // ensures if event ending time comes after starting time
  static validateEventTimeOrder(event: EventDTO) {
    const { start_hour, start_minute, end_hour, end_minute } = event;
    badRequestExceptionThrower(
      start_hour > end_hour ||
        (start_hour === end_hour && start_minute >= end_minute),
      'Event ending time must be after starting time',
    );
  }

  // return whether recurring interval is daily or not
  static doesDailyRecurr(interval: Interval) {
    return interval === Interval.DAILY;
  }

  // return whether event in past recurr weekly and overlap with event in future
  // interval = recurring interval of past event
  static doesWeeklyOverlap(interval: Interval, past: Date, future: Date) {
    return interval === Interval.WEEKLY && past.getDay() === future.getDay();
  }

  // return whether event in past recurr monthly and overlap with event in future
  // interval = recurring interval of past event
  static doesMonthlyOverlap(interval: Interval, past: Date, future: Date) {
    if (interval !== Interval.MONTHLY) return false;
    const isLeap = isLeapYear(future.getFullYear());
    const maxMonthdays = getMonthDays(isLeap, future.getMonth() + 1);
    // e.g. if event is scheduled on 31, months that have days less than 31 will have the event at end of the month
    // check for end of month shifted past events
    if (future.getDate() === maxMonthdays && past.getDate() >= maxMonthdays)
      return true;
    return future.getDate() === past.getDate(); // check date which exist in all months
  }

  // return whether event in past recurr yearly and overlap with event in future
  // interval = recurring interval of past event
  static doesYearlyOverlap(interval: Interval, past: Date, future: Date) {
    if (interval !== Interval.YEARLY) return false;
    if (past.getMonth() !== future.getMonth()) return false;
    return this.doesMonthlyOverlap(Interval.MONTHLY, past, future);
  }

  // to reduce code duplication
  static doesOverlapWrapper(interval: Interval, past: Date, future: Date) {
    if (EventService.doesWeeklyOverlap(interval, past, future)) return true;
    if (EventService.doesMonthlyOverlap(interval, past, future)) return true;
    return EventService.doesYearlyOverlap(interval, past, future);
  }

  // check if event to be scheduled(on target date) overlap with recurring past event
  static doesOverlapWithPastEvent(pastEvent: Event, targetDate: Date) {
    const { repeat_interval, date } = pastEvent;
    if (!repeat_interval) return false; // past event does not recurr
    const eventDate = new Date(`${date} ${OFFSET}`);
    if (EventService.doesDailyRecurr(repeat_interval)) return true;
    return EventService.doesOverlapWrapper(
      repeat_interval,
      eventDate,
      targetDate,
    );
  }

  static doesOverlapWithFutureEvent(
    futureEvent: Event, // start to occurr later than event to be scheduled (target event)
    repeat_interval: Interval, // repeat interval of target event
    targetDate: Date, // date of target event
  ) {
    const eventDate = new Date(`${futureEvent.date} ${OFFSET}`);
    const future_interval = futureEvent.repeat_interval;
    const target_interval = repeat_interval;
    if (!target_interval) return false; // target event is non-recurring event
    if (EventService.doesDailyRecurr(future_interval)) return true;
    if (EventService.doesDailyRecurr(target_interval)) return true;
    return EventService.doesOverlapWrapper(
      target_interval,
      targetDate,
      eventDate,
    );
  }

  // get events from database
  async getEvents(condition: string, parameters?: ObjectLiteral) {
    return await getConnection()
      .createQueryBuilder()
      .from(Event, 'event')
      .where(condition, parameters)
      .getRawMany();
  }

  // helper to create database query
  static getSelectQueryBuilder() {
    return getConnection().createQueryBuilder();
  }

  // filter out events that occurr on the same day with target event
  static selectEvents(
    events: Event[],
    targetDate: Date,
    target_interval?: Interval,
  ) {
    const result = [];
    for (const event of events) {
      const eventDate = new Date(`${event.date} ${OFFSET}`);
      // event ocuur same day
      if (eventDate.toDateString() === targetDate.toDateString()) {
        result.push(event);
      } else if (
        eventDate.getTime() < targetDate.getTime() &&
        this.doesOverlapWithPastEvent(event, targetDate)
      ) {
        result.push(event);
      } else if (
        eventDate.getTime() > targetDate.getTime() &&
        target_interval &&
        this.doesOverlapWithFutureEvent(event, target_interval, targetDate)
      ) {
        result.push(event);
      }
    }
    return result;
  }

  // ensures that event to be scheduled does not overlap with other events
  async validateNonOverlapping(event: EventDTO, eventDate: Date) {
    const parameters = {
      start_time: `${event.start_hour}:${event.start_minute}`,
      end_time: `${event.end_hour}:${event.end_minute}`,
    };
    // get events with overlapping time but not necessarily date
    const overlappingTime = await this.getEvents(
      '( event.start_time >= TIME(:start_time) AND event.start_time < TIME(:end_time) ) \
        OR ( event.end_time > TIME(:start_time) AND event.end_time <= TIME(:end_time) ) \
        OR ( event.start_time <= TIME(:start_time) AND event.end_time >= TIME(:end_time) )',
      parameters,
    );
    if (!overlappingTime || overlappingTime.length === 0) return;
    const cleanedEvents = EventService.selectEvents(
      overlappingTime,
      eventDate,
      event.repeat_interval,
    );
    badRequestExceptionThrower(
      cleanedEvents.length > 0,
      'Overlapping events are not allowed',
    );
  }

  // create and schedules event
  async createEvent(event: EventDTO) {
    EventService.validateMonthDate(event);
    EventService.validateEventTimeOrder(event);
    const eventDate = EventService.getPackedDate(event);
    await this.validateNonOverlapping(event, eventDate);
    return await EventService.getSelectQueryBuilder()
      .insert()
      .into(Event)
      .values({
        date: `${eventDate.getFullYear()}-${
          eventDate.getMonth() + 1
        }-${eventDate.getDate()}`,
        start_time: `${event.start_hour}:${event.start_minute}`,
        end_time: `${event.end_hour}:${event.end_minute}`,
        notes: event.notes,
        repeat_interval: event.repeat_interval,
      })
      .execute();
  }

  // fetch events that occurr on the corresponding date
  async getEventsByDate(input: GetEventDTO) {
    EventService.validateMonthDate(input);
    const query = 'event.date <= DATE(:date)';
    const parameters = {
      date: `${input.year}-${input.month}-${input.date}`,
    };
    const events = await this.getEvents(query, parameters);
    return EventService.selectEvents(events, EventService.getPackedDate(input));
  }

  // fetch events that occurr on the corresponding week
  // input is date to start getting events for
  async getEventsByWeek(input: GetEventDTO) {
    EventService.validateMonthDate(input);
    const inputDate = EventService.getPackedDate(input);
    const endOfWeek = new Date(inputDate.getTime() + SECINDAY * DAYSINWEEK);
    const query =
      'event.date <= DATE(:end) AND ( \
        ( event.date >= DATE(:start) AND event.repeat_interval IS NULL ) OR \
        ( event.repeat_interval IN (:...intervals) ) OR \
        ( event.repeat_interval = :monthly AND \
          ( ( MONTH(:end) > MONTH(:start) AND (  DAYOFMONTH(event.date) >= DAYOFMONTH(:start) OR DAYOFMONTH(event.date) <= DAYOFMONTH(:end) ) ) OR \
            ( DAYOFMONTH(event.date) >= DAYOFMONTH(:start) AND DAYOFMONTH(event.date) <= DAYOFMONTH(:end) ) ) ) OR \
        ( event.repeat_interval = :yearly AND \
          ( ( MONTH(event.date) = MONTH(:start) AND DAYOFMONTH(event.date) >= DAYOFMONTH(:start) ) OR \
            ( MONTH(event.date) = MONTH(:end) AND DAYOFMONTH(event.date) <= DAYOFMONTH(:end) ) ) ) )';
    const parameters = {
      intervals: [Interval.DAILY, Interval.WEEKLY],
      monthly: Interval.MONTHLY,
      yearly: Interval.YEARLY,
      end: `${endOfWeek.getFullYear()}-${
        endOfWeek.getMonth() + 1
      }-${endOfWeek.getDate()}`,
      start: `${input.year}-${input.month}-${input.date}`,
    };
    return await this.getEvents(query, parameters);
  }
}
