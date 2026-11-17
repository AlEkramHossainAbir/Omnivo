import type { ShopShipment } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { parcelViews, paymentLine, type ParcelView } from './tracking-view';

const cancelled: ShopShipment = {
  courier: 'redx',
  trackingCode: 'RX1108A77',
  trackingUrl: null,
  events: [
    { status: 'booked', at: '2026-11-08T15:35:00+06:00', note: null },
    { status: 'cancelled', at: '2026-11-08T18:10:00+06:00', note: 'Cancelled by merchant' },
  ],
};
const delivered: ShopShipment = {
  courier: 'pathao',
  trackingCode: 'DH1108229K4',
  trackingUrl: 'https://merchant.pathao.com/tracking?consignment_id=DH1108229K4',
  events: [
    { status: 'booked', at: '2026-11-08T18:20:00+06:00', note: null },
    { status: 'delivered', at: '2026-11-09T17:40:00+06:00', note: null },
  ],
};

describe('paymentLine', () => {
  it('asks for cash at the door until a Cash on Delivery order is delivered', () => {
    for (const status of ['pending', 'confirmed', 'packed', 'shipped'] as const) {
      expect(paymentLine({ paymentMethod: 'cod', status })).toBe('payOnDelivery');
    }
  });

  it('says nothing about cash once there is nothing left to pay', () => {
    for (const status of ['delivered', 'cancelled', 'returned'] as const) {
      expect(paymentLine({ paymentMethod: 'cod', status })).toBeNull();
    }
  });

  it('says an online order is paid, whatever its status', () => {
    expect(paymentLine({ paymentMethod: 'online', status: 'shipped' })).toBe('paidOnline');
    expect(paymentLine({ paymentMethod: 'online', status: 'delivered' })).toBe('paidOnline');
  });
});

describe('parcelViews', () => {
  const statuses = (view: ParcelView | undefined) => view?.events.map(({ event }) => event.status);
  const states = (view: ParcelView | undefined) => view?.events.map(({ state }) => state);

  it('puts the newest parcel and the newest event first', () => {
    const [now, earlier] = parcelViews([cancelled, delivered]);
    expect(now?.shipment.courier).toBe('pathao');
    expect(now?.current).toBe(true);
    expect(statuses(now)).toEqual(['delivered', 'booked']);
    expect(earlier?.shipment.courier).toBe('redx');
    expect(earlier?.current).toBe(false);
    expect(statuses(earlier)).toEqual(['cancelled', 'booked']);
  });

  it('marks where the parcel is now, until its way ends', () => {
    const onHold: ShopShipment = {
      ...delivered,
      events: [
        { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
        { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
      ],
    };
    expect(states(parcelViews([onHold])[0])).toEqual(['current', 'done']);
    // Delivered is the end of the way: done, like the order timeline's last step
    expect(states(parcelViews([delivered])[0])).toEqual(['done', 'done']);
    // An earlier parcel is over, even though its newest event is not an end
    expect(states(parcelViews([onHold, delivered])[1])).toEqual(['done', 'done']);
  });

  it('leaves the tracking it was given as it was', () => {
    const shipments = [cancelled, delivered];
    parcelViews(shipments);
    expect(shipments[0]).toBe(cancelled);
    expect(cancelled.events[0]?.status).toBe('booked');
  });

  it('has nothing to draw before the parcel is booked', () => {
    expect(parcelViews([])).toEqual([]);
  });
});
