import { Cancel01Icon, Note01Icon } from '@hugeicons/core-free-icons';
import { MAX_HELD_CARTS } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  dropCart,
  type HeldCartItem,
  heldCarts,
  holdCart,
  type LocalCopy,
  resumeCart,
} from '@omnivo/sync';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  IconButton,
  TextField,
  toast,
} from '@omnivo/ui';
import { useCallback, useId, useState } from 'react';

import { useLocalQuery } from '../lib/local-data';
import { type Cart, heldCartOf } from '../lib/pos';
import { hasPaisa } from './pos-parts';

// Step 20b (decision 10): held bills. The cashier holds a cart while the next customer pays, and
// resumes it later. On this device only, under the shift: the close drops them. A chunk of its own,
// like the shift's dialogs.

// What the screen hands over to hold: the cart and its total now (the list's row says it)
export interface ScreenCart {
  cart: Cart;
  total: string;
}

// F8: an optional name ("Customer in the blue shirt"), then the cart leaves the screen
export function HoldDialog({
  copy,
  shiftId,
  screen,
  onClose,
  onHeld,
}: {
  copy: LocalCopy;
  shiftId: string;
  screen: ScreenCart;
  onClose: () => void;
  onHeld: () => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const typed = name.trim();
      const answer = await holdCart(
        copy,
        shiftId,
        heldCartOf(screen.cart, screen.total, typed === '' ? null : typed),
      );
      if (answer === 'full') {
        setError(t('pos.hold.full', { max: format.number(MAX_HELD_CARTS) }));
        return;
      }
      toast(t('pos.hold.held'));
      onHeld();
    } catch {
      setError(t('sync.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        title={t('pos.hold.title')}
        description={t('pos.hold.description')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving}>
              {t('pos.hold.save')}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && <FormAlert message={error} />}
          {/* Enter holds at once: the cashier often types no name */}
          <TextField
            label={t('pos.hold.name')}
            optional
            autoFocus
            maxLength={60}
            placeholder={t('pos.hold.namePlaceholder')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The held bills of the shift, the oldest first. Resume puts one on the screen (the screen's own
// cart, if it has lines, is held in its place: nothing is lost); Drop throws one away.
export function HeldDialog({
  copy,
  shiftId,
  screen,
  timeZone,
  onClose,
  onResume,
}: {
  copy: LocalCopy;
  shiftId: string;
  screen: ScreenCart;
  // The workspace's, like every time on the counter (the receipt's)
  timeZone: string;
  onClose: () => void;
  onResume: (cart: Cart) => void;
}) {
  const { t, format } = useLocale();
  const readHeld = useCallback((open: LocalCopy) => heldCarts(open, shiftId), [shiftId]);
  const held = useLocalQuery(readHeld);
  const [busy, setBusy] = useState(false);
  const swaps = screen.cart.lines.length > 0;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch {
      toast(t('sync.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const resume = (item: HeldCartItem) =>
    run(async () => {
      const cart = await resumeCart(
        copy,
        shiftId,
        item.id,
        swaps ? heldCartOf(screen.cart, screen.total, null) : null,
      );
      // null: another tab took it meanwhile; the list's live read drops the row
      if (cart) onResume(cart.cart);
    });

  const drop = (item: HeldCartItem) =>
    run(async () => {
      await dropCart(copy, item.id);
      toast(t('pos.hold.dropped'));
    });

  const nameOf = (item: HeldCartItem) =>
    item.name ?? t('pos.hold.unnamed', { time: format.dateTime(new Date(item.heldAt), timeZone) });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title={t('pos.hold.listTitle')} description={t('pos.hold.listDescription')}>
        {held?.length === 0 ? (
          <EmptyState
            icon={Note01Icon}
            title={t('pos.hold.emptyTitle')}
            description={t('pos.hold.emptyBody')}
          />
        ) : (
          <div className="grid gap-3">
            <ul className="divide-y divide-line rounded-control border border-line">
              {(held ?? []).map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-body-sm font-medium">{nameOf(item)}</span>
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('pos.hold.row', {
                        items: t('pos.itemCount', {
                          count: item.items,
                          formatted: format.number(item.items),
                        }),
                        total: format.money(item.total, { decimals: hasPaisa(item.total) ? 2 : 0 }),
                      })}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void resume(item)}
                  >
                    {t('pos.hold.resume')}
                  </Button>
                  <IconButton
                    icon={Cancel01Icon}
                    label={t('pos.hold.drop', { name: nameOf(item) })}
                    disabled={busy}
                    onClick={() => void drop(item)}
                  />
                </li>
              ))}
            </ul>
            {swaps && <p className="text-label text-ink-3">{t('pos.hold.resumeHolds')}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
