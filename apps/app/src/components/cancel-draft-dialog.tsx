import { Button, Dialog, DialogClose, DialogContent, FormAlert } from '@omnivo/ui';

// "Cancel" on a numbered draft (step 17c): a bill or a payment that approvers saw keeps its number,
// so it is cancelled, never deleted (decision 13). Its own chunk, loaded when the button is
// pressed: with the dialog inside, the bill form and the payment form were over their 100 KB
// budget, and most drafts are never cancelled. The form passes its own words.
export function CancelDraftDialog({
  title,
  body,
  keep,
  confirm,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  // The button that closes the dialog ("Keep the bill"), never just "Cancel" beside "Cancel bill"
  keep: string;
  confirm: string;
  pending: boolean;
  // purchase_order_billed, version_conflict, … as a code
  error: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={title}
        description={body}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{keep}</Button>
            </DialogClose>
            <Button disabled={pending} onClick={onConfirm}>
              {confirm}
            </Button>
          </>
        }
      >
        {error !== undefined && <FormAlert message={error} />}
      </DialogContent>
    </Dialog>
  );
}
