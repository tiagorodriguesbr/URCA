import React, { useMemo, useRef, useState } from 'react';
import {
  Download,
  Edit3,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  formatCurrencyBRL,
  formatDateBR,
  getTodayIsoDate,
  PAYMENT_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  validatePaymentPayload,
  type PartnerRecord,
  type PaymentCategory,
  type PaymentMethod,
  type PaymentReceipt,
  type PaymentStatus,
  type ReceiptImageInput,
  type TransitionPayment,
} from '../types/domain';
import { getFirestoreErrorMessage } from '../lib/firebase';
import {
  compressReceiptImageFile,
  formatFileBytes,
  type CompressedReceiptImage,
} from '../lib/imageUtils';
import type { ConfirmDialogState } from './ConfirmActionModal';

interface PaymentsViewProps {
  payments: TransitionPayment[];
  partners: PartnerRecord[];
  loading: boolean;
  canEdit: boolean;
  onCreatePayment: (input: {
    description: string;
    amount: number;
    paidBy: string;
    category: PaymentCategory;
    paymentMethod: PaymentMethod;
    paymentDate: string;
    status: PaymentStatus;
    receiptRef: string;
    notes: string;
    receiptImage?: ReceiptImageInput | null;
  }) => Promise<void>;
  onUpdatePayment: (
    existing: TransitionPayment,
    updates: {
      description: string;
      amount: number;
      paidBy: string;
      category: PaymentCategory;
      paymentMethod: PaymentMethod;
      paymentDate: string;
      status: PaymentStatus;
      receiptRef: string;
      notes: string;
      receiptAction?: 'keep' | 'replace' | 'remove';
      receiptImage?: ReceiptImageInput | null;
    }
  ) => Promise<void>;
  onDeletePayment: (payment: TransitionPayment) => Promise<void>;
  onLoadReceipt: (paymentId: string) => Promise<PaymentReceipt | null>;
  requestConfirmation: (dialog: Omit<ConfirmDialogState, 'open'>) => void;
  externalOpenCreate?: boolean;
  onConsumeExternalOpenCreate?: () => void;
}

export const PaymentsView: React.FC<PaymentsViewProps> = ({
  payments,
  partners,
  loading,
  canEdit,
  onCreatePayment,
  onUpdatePayment,
  onDeletePayment,
  onLoadReceipt,
  requestConfirmation,
  externalOpenCreate,
  onConsumeExternalOpenCreate,
}) => {
  const [payerFilter, setPayerFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | PaymentCategory>('all');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<TransitionPayment | null>(null);

  const payerOptions = useMemo(() => {
    const set = new Set<string>();
    partners
      .filter((p) => p.active)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))
      .forEach((p) => set.add(p.displayName));
    set.add('Empresa Creps Urca');
    payments.forEach((p) => {
      if (p.paidBy.trim()) set.add(p.paidBy.trim());
    });
    return Array.from(set);
  }, [partners, payments]);

  const [description, setDescription] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [paidBy, setPaidBy] = useState<string>(payerOptions[0] || 'Empresa Creps Urca');
  const [customPaidBy, setCustomPaidBy] = useState('');
  const [category, setCategory] = useState<PaymentCategory>('Equipamentos & PDV');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('PIX');
  const [paymentDate, setPaymentDate] = useState(getTodayIsoDate());
  const [status, setStatus] = useState<PaymentStatus>('pago');
  const [receiptRef, setReceiptRef] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Receipt image attachment state inside Create/Edit modal
  const [receiptImage, setReceiptImage] = useState<CompressedReceiptImage | null>(null);
  const [receiptAction, setReceiptAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [existingReceiptUrl, setExistingReceiptUrl] = useState<string | null>(null);
  const [existingReceiptName, setExistingReceiptName] = useState<string>('');
  const [existingReceiptSize, setExistingReceiptSize] = useState<number>(0);
  const [loadingExistingReceipt, setLoadingExistingReceipt] = useState(false);
  const [compressingReceipt, setCompressingReceipt] = useState(false);
  const [receiptUploadError, setReceiptUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeEditIdRef = useRef<string | null>(null);

  // Receipt lightbox preview state
  const [previewPayment, setPreviewPayment] = useState<TransitionPayment | null>(null);
  const [previewReceipt, setPreviewReceipt] = useState<PaymentReceipt | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const activePreviewIdRef = useRef<string | null>(null);

  React.useEffect(() => {
    if (externalOpenCreate && canEdit) {
      openCreateModal();
      onConsumeExternalOpenCreate?.();
    }
  }, [externalOpenCreate, canEdit]);

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    payments.forEach((p) => {
      if (p.paymentDate.length >= 7) set.add(p.paymentDate.slice(0, 7));
    });
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [payments]);

  const filteredPayments = useMemo(() => {
    return payments
      .filter((p) => {
        if (payerFilter !== 'all' && p.paidBy !== payerFilter) return false;
        if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
        if (monthFilter !== 'all' && !p.paymentDate.startsWith(monthFilter)) return false;
        if (searchTerm.trim()) {
          const q = searchTerm.toLowerCase();
          return (
            p.description.toLowerCase().includes(q) ||
            p.receiptRef.toLowerCase().includes(q) ||
            (p.receiptAttachmentName || '').toLowerCase().includes(q) ||
            p.notes.toLowerCase().includes(q) ||
            p.paidBy.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  }, [payments, payerFilter, categoryFilter, monthFilter, searchTerm]);

  const summaryCards = useMemo(() => {
    const total = payments.reduce((s, p) => s + p.amount, 0);
    const activePartnerNames = partners
      .filter((p) => p.active)
      .map((p) => p.displayName);

    const cards: Array<{ label: string; amount: number; accent: string }> = [
      {
        label: 'Total Geral Acumulado',
        amount: total,
        accent: 'text-slate-900 dark:text-slate-50',
      },
    ];

    activePartnerNames.forEach((name, idx) => {
      const amt = payments
        .filter((p) => p.paidBy === name)
        .reduce((s, p) => s + p.amount, 0);
      cards.push({
        label: `Pago por ${name}`,
        amount: amt,
        accent:
          idx % 2 === 0
            ? 'text-teal-700 dark:text-teal-400'
            : 'text-sky-700 dark:text-sky-400',
      });
    });

    const empresaAmt = payments
      .filter((p) => p.paidBy === 'Empresa Creps Urca')
      .reduce((s, p) => s + p.amount, 0);
    cards.push({
      label: 'Conta Creps Urca',
      amount: empresaAmt,
      accent: 'text-slate-900 dark:text-slate-50',
    });

    const filteredTotal = filteredPayments.reduce((s, p) => s + p.amount, 0);
    return { cards, filteredTotal };
  }, [payments, partners, filteredPayments]);

  function resetReceiptFormState() {
    setReceiptImage(null);
    setReceiptAction('keep');
    setExistingReceiptUrl(null);
    setExistingReceiptName('');
    setExistingReceiptSize(0);
    setLoadingExistingReceipt(false);
    setCompressingReceipt(false);
    setReceiptUploadError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function openCreateModal() {
    activeEditIdRef.current = null;
    setEditingPayment(null);
    setDescription('');
    setAmountInput('');
    setPaidBy(payerOptions[0] || 'Empresa Creps Urca');
    setCustomPaidBy('');
    setCategory('Equipamentos & PDV');
    setPaymentMethod('PIX');
    setPaymentDate(getTodayIsoDate());
    setStatus('pago');
    setReceiptRef('');
    setNotes('');
    setFormError(null);
    resetReceiptFormState();
    setModalOpen(true);
  }

  function openEditModal(payment: TransitionPayment) {
    activeEditIdRef.current = payment.id;
    setEditingPayment(payment);
    setDescription(payment.description);
    setAmountInput(String(payment.amount));
    if (payerOptions.includes(payment.paidBy)) {
      setPaidBy(payment.paidBy);
      setCustomPaidBy('');
    } else {
      setPaidBy('__custom__');
      setCustomPaidBy(payment.paidBy);
    }
    setCategory(payment.category);
    setPaymentMethod(payment.paymentMethod);
    setPaymentDate(payment.paymentDate);
    setStatus(payment.status);
    setReceiptRef(payment.receiptRef);
    setNotes(payment.notes);
    setFormError(null);
    resetReceiptFormState();
    setModalOpen(true);

    if (payment.receiptAttachmentName) {
      setExistingReceiptName(payment.receiptAttachmentName);
      setLoadingExistingReceipt(true);
      void onLoadReceipt(payment.id)
        .then((rec) => {
          if (activeEditIdRef.current !== payment.id) return;
          if (rec) {
            setExistingReceiptUrl(rec.imageDataUrl);
            setExistingReceiptName(rec.fileName);
            setExistingReceiptSize(rec.byteSize);
          }
        })
        .catch((err) => {
          if (activeEditIdRef.current !== payment.id) return;
          setReceiptUploadError(
            `Não foi possível carregar a imagem atual: ${getFirestoreErrorMessage(err)}`
          );
        })
        .finally(() => {
          if (activeEditIdRef.current === payment.id) {
            setLoadingExistingReceipt(false);
          }
        });
    }
  }

  async function handleReceiptFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setReceiptUploadError(null);
    setCompressingReceipt(true);
    try {
      const compressed = await compressReceiptImageFile(file);
      setReceiptImage(compressed);
      setReceiptAction('replace');
    } catch (err) {
      setReceiptUploadError(
        err instanceof Error ? err.message : 'Falha ao processar a imagem selecionada.'
      );
    } finally {
      setCompressingReceipt(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleRemoveReceiptInForm() {
    setReceiptImage(null);
    setExistingReceiptUrl(null);
    setExistingReceiptName('');
    setExistingReceiptSize(0);
    setReceiptUploadError(null);
    setReceiptAction('remove');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function handleOpenReceiptPreview(payment: TransitionPayment) {
    activePreviewIdRef.current = payment.id;
    setPreviewPayment(payment);
    setPreviewReceipt(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const rec = await onLoadReceipt(payment.id);
      if (activePreviewIdRef.current !== payment.id) return;
      if (!rec) {
        setPreviewError('A imagem deste comprovante não foi encontrada no banco de dados.');
      } else {
        setPreviewReceipt(rec);
      }
    } catch (err) {
      if (activePreviewIdRef.current !== payment.id) return;
      setPreviewError(getFirestoreErrorMessage(err));
    } finally {
      if (activePreviewIdRef.current === payment.id) {
        setPreviewLoading(false);
      }
    }
  }

  function closeReceiptPreview() {
    activePreviewIdRef.current = null;
    setPreviewPayment(null);
    setPreviewReceipt(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (compressingReceipt) return;

    const parsedAmount = Number(amountInput.replace(',', '.'));
    const resolvedPaidBy = paidBy === '__custom__' ? customPaidBy.trim() : paidBy;

    const basePayload = {
      description,
      amount: parsedAmount,
      paidBy: resolvedPaidBy,
      category,
      paymentMethod,
      paymentDate,
      status,
      receiptRef,
      notes,
    };
    const err = validatePaymentPayload(basePayload);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);

    const effectiveReceiptLabel = receiptImage
      ? receiptImage.fileName
      : receiptAction === 'remove'
      ? 'Removido'
      : existingReceiptName || 'Não anexada';

    if (editingPayment) {
      requestConfirmation({
        title: 'Confirmar Alteração de Pagamento',
        description:
          'Confirme a atualização deste lançamento financeiro. O valor e os campos modificados serão auditados.',
        details: [
          { label: 'Descrição', value: description.trim() },
          { label: 'Valor', value: formatCurrencyBRL(parsedAmount) },
          { label: 'Pago por', value: resolvedPaidBy },
          { label: 'Data', value: formatDateBR(paymentDate) },
          { label: 'Imagem do comprovante', value: effectiveReceiptLabel },
        ],
        confirmLabel: 'Confirmar Alteração',
        tone: 'primary',
        onConfirm: async () => {
          await onUpdatePayment(editingPayment, {
            ...basePayload,
            receiptAction,
            receiptImage,
          });
          setModalOpen(false);
        },
      });
    } else {
      requestConfirmation({
        title: 'Confirmar Lançamento de Pagamento',
        description:
          'Confirme o registro deste pagamento pré-operacional da Creps Urca.',
        details: [
          { label: 'Descrição', value: description.trim() },
          { label: 'Valor', value: formatCurrencyBRL(parsedAmount) },
          { label: 'Pago por', value: resolvedPaidBy },
          { label: 'Categoria', value: category },
          { label: 'Imagem do comprovante', value: effectiveReceiptLabel },
        ],
        confirmLabel: 'Confirmar Lançamento',
        tone: 'primary',
        onConfirm: async () => {
          await onCreatePayment({
            ...basePayload,
            receiptImage,
          });
          setModalOpen(false);
        },
      });
    }
  };

  const handleDelete = (payment: TransitionPayment) => {
    if (!canEdit) return;
    requestConfirmation({
      title: 'Confirmar Exclusão de Pagamento',
      description:
        'Este lançamento (e eventual comprovante anexado) será removido da soma financeira. O registro da remoção permanecerá nos logs de auditoria.',
      details: [
        { label: 'Descrição', value: payment.description },
        { label: 'Valor', value: formatCurrencyBRL(payment.amount) },
        { label: 'Pago por', value: payment.paidBy },
      ],
      confirmLabel: 'Excluir Pagamento',
      tone: 'danger',
      onConfirm: async () => {
        await onDeletePayment(payment);
      },
    });
  };

  const activePreviewUrlInForm =
    receiptImage?.imageDataUrl || (receiptAction === 'keep' ? existingReceiptUrl : null);
  const activePreviewNameInForm =
    receiptImage?.fileName || (receiptAction === 'keep' ? existingReceiptName : '');
  const activePreviewSizeInForm =
    receiptImage?.byteSize || (receiptAction === 'keep' ? existingReceiptSize : 0);

  return (
    <div className="space-y-6">
      {!canEdit && (
        <div className="px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-300">
          <strong>Modo Somente Leitura (Gerente):</strong> visualização do histórico de pagamentos da implantação. Inclusões e edições financeiras exigem permissão liberada por um Sócio ou Diretor.
        </div>
      )}

      {/* Partner Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.cards.map((card) => (
          <div
            key={card.label}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4"
          >
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{card.label}</p>
            <p className={`font-mono tabular-nums text-xl font-bold mt-1 ${card.accent}`}>
              {formatCurrencyBRL(card.amount)}
            </p>
          </div>
        ))}
      </div>

      {/* Filter & Action Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          {(['all', ...payerOptions] as const).map((payer) => (
            <button
              key={payer}
              type="button"
              onClick={() => setPayerFilter(payer)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                payerFilter === payer
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {payer === 'all' ? 'Todos Pagadores' : payer}
            </button>
          ))}
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Registrar Pagamento
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar descrição, NF ou pagador..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as 'all' | PaymentCategory)}
          aria-label="Filtrar categoria financeira"
          className="px-3.5 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
        >
          <option value="all">Todas as categorias</option>
          {PAYMENT_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>

        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          aria-label="Filtrar por mês"
          className="px-3.5 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm font-mono text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
        >
          <option value="all">Todos os meses</option>
          {availableMonths.map((ym) => (
            <option key={ym} value={ym}>
              {ym}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 animate-pulse">
          <div className="h-4 w-full bg-slate-200 dark:bg-slate-800 rounded" />
          <div className="h-4 w-3/4 bg-slate-200 dark:bg-slate-800 rounded" />
        </div>
      ) : filteredPayments.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Nenhum pagamento encontrado
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Registre taxas, exames, equipamentos, sistemas ou estoque inicial pagos antes da abertura.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">Data</th>
                  <th className="py-3 px-4">Descrição</th>
                  <th className="py-3 px-4">Pago Por</th>
                  <th className="py-3 px-4">Forma</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Valor</th>
                  {canEdit && <th className="py-3 px-4 text-right">Ações</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
                {filteredPayments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300">
                      {formatDateBR(payment.paymentDate)}
                    </td>
                    <td className="py-3.5 px-4 max-w-md">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {payment.description}
                      </p>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span>{payment.category}</span>
                        {payment.receiptRef && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">Ref: {payment.receiptRef}</span>
                          </>
                        )}
                        {payment.receiptAttachmentName && (
                          <>
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() => void handleOpenReceiptPreview(payment)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-teal-200 dark:border-teal-800 bg-teal-50/80 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/60 font-medium transition-colors"
                            >
                              <ImageIcon className="w-3 h-3" />
                              Ver comprovante
                            </button>
                          </>
                        )}
                        {payment.hasPendingWrites && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-600 dark:text-amber-400">
                              Pendente offline
                            </span>
                          </>
                        )}
                      </div>
                      {payment.notes && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                          {payment.notes}
                        </p>
                      )}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-xs font-medium text-slate-800 dark:text-slate-200">
                      {payment.paidBy}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-600 dark:text-slate-400">
                      {payment.paymentMethod}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-xs">
                      <span
                        className={
                          payment.status === 'pago'
                            ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                            : 'text-amber-700 dark:text-amber-400 font-medium'
                        }
                      >
                        {payment.status === 'pago' ? 'Pago' : 'Agendado'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrencyBRL(payment.amount)}
                    </td>
                    {canEdit && (
                      <td className="py-3.5 px-4 whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(payment)}
                            aria-label={`Editar ${payment.description}`}
                            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(payment)}
                            aria-label={`Excluir ${payment.description}`}
                            className="p-2 rounded-lg text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-xs font-semibold text-slate-900 dark:text-slate-100">
                  <td colSpan={5} className="py-3 px-4 text-right">
                    Subtotal do filtro ({filteredPayments.length} itens):
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    {formatCurrencyBRL(summaryCards.filteredTotal)}
                  </td>
                  {canEdit && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Modal */}
      {modalOpen && canEdit && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                {editingPayment ? 'Editar Pagamento' : 'Registrar Pagamento Pré-Operacional'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                  {formError}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Descrição do pagamento *
                </label>
                <input
                  type="text"
                  required
                  maxLength={160}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ex.: Taxa de implantação sistema Gcom + certificado digital"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Valor (R$) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    placeholder="0,00"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Data do pagamento *
                  </label>
                  <input
                    type="date"
                    required
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-mono text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Pago por
                  </label>
                  <select
                    value={paidBy}
                    onChange={(e) => setPaidBy(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  >
                    {payerOptions.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                    <option value="__custom__">Outro pagador...</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Categoria
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as PaymentCategory)}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  >
                    {PAYMENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {paidBy === '__custom__' && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Nome do pagador *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={80}
                    value={customPaidBy}
                    onChange={(e) => setCustomPaidBy(e.target.value)}
                    placeholder="Informe o nome do pagador"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Meio de pagamento
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Situação
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as PaymentStatus)}
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                  >
                    {PAYMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s === 'pago' ? 'Pago' : 'Agendado'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Referência do comprovante / NF (opcional)
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={receiptRef}
                  onChange={(e) => setReceiptRef(e.target.value)}
                  placeholder="Ex.: NF-e 00412 ou ID PIX"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                />
              </div>

              {/* Receipt Image Attachment (JPEG / PNG) */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Imagem do comprovante (JPEG ou PNG, opcional)
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  onChange={(e) => void handleReceiptFileChange(e)}
                  className="hidden"
                />

                {receiptUploadError && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                    {receiptUploadError}
                  </div>
                )}

                {compressingReceipt ? (
                  <div className="flex items-center gap-2.5 p-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-600 dark:text-slate-300">
                    <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
                    Otimizando imagem do comprovante...
                  </div>
                ) : activePreviewUrlInForm ? (
                  <div className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950">
                    <img
                      src={activePreviewUrlInForm}
                      alt={activePreviewNameInForm || 'Comprovante'}
                      className="w-16 h-16 rounded-md object-cover border border-slate-200 dark:border-slate-700 bg-white shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {activePreviewNameInForm || 'comprovante.jpg'}
                      </p>
                      {activePreviewSizeInForm > 0 && (
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          JPEG otimizado · {formatFileBytes(Math.round(activePreviewSizeInForm * 0.75))}
                        </p>
                      )}
                      <div className="flex items-center gap-2 pt-0.5">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline"
                        >
                          Trocar imagem
                        </button>
                        <span className="text-slate-300 dark:text-slate-700">|</span>
                        <button
                          type="button"
                          onClick={handleRemoveReceiptInForm}
                          className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
                        >
                          Remover
                        </button>
                      </div>
                    </div>
                  </div>
                ) : loadingExistingReceipt ? (
                  <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-600 dark:text-slate-300">
                    <span className="inline-flex items-center gap-2 truncate">
                      <Loader2 className="w-4 h-4 animate-spin text-teal-600 shrink-0" />
                      Carregando comprovante atual ({existingReceiptName})...
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveReceiptInForm}
                      className="text-red-600 dark:text-red-400 hover:underline shrink-0"
                    >
                      Remover
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 hover:border-teal-600 hover:bg-teal-50/40 dark:hover:bg-teal-950/20 text-xs text-slate-600 dark:text-slate-300 transition-colors"
                  >
                    <ImagePlus className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0" />
                    <span>Clique para anexar imagem (.jpg, .jpeg ou .png)</span>
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Observações (opcional)
                </label>
                <textarea
                  rows={2}
                  maxLength={600}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Detalhes para acerto de contas entre os sócios..."
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={compressingReceipt}
                  className="px-4 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-700 text-white text-sm font-semibold transition-colors disabled:opacity-60"
                >
                  {editingPayment ? 'Revisar Alteração' : 'Revisar Lançamento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Receipt Image Preview Lightbox */}
      {previewPayment && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          onClick={closeReceiptPreview}
        >
          <div
            className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xl max-h-[92vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                  Comprovante · {previewPayment.description}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {formatDateBR(previewPayment.paymentDate)} · {previewPayment.paidBy} ·{' '}
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                    {formatCurrencyBRL(previewPayment.amount)}
                  </span>
                  {previewPayment.receiptRef ? ` · Ref: ${previewPayment.receiptRef}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={closeReceiptPreview}
                aria-label="Fechar comprovante"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 flex items-center justify-center bg-slate-100/70 dark:bg-slate-950/80 min-h-[240px]">
              {previewLoading ? (
                <div className="flex flex-col items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
                  <span>Carregando imagem do comprovante...</span>
                </div>
              ) : previewError ? (
                <div className="max-w-md p-4 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 text-center">
                  {previewError}
                </div>
              ) : previewReceipt ? (
                <img
                  src={previewReceipt.imageDataUrl}
                  alt={previewReceipt.fileName}
                  className="max-h-[65vh] w-auto max-w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white object-contain shadow-sm"
                />
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              <span className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                {previewReceipt
                  ? `${previewReceipt.fileName} (${formatFileBytes(Math.round(previewReceipt.byteSize * 0.75))})`
                  : previewPayment.receiptAttachmentName || ''}
              </span>
              <div className="flex items-center gap-2">
                {previewReceipt && (
                  <a
                    href={previewReceipt.imageDataUrl}
                    download={previewReceipt.fileName}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-600 dark:hover:bg-teal-700 text-white text-xs font-semibold transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Baixar imagem
                  </a>
                )}
                <button
                  type="button"
                  onClick={closeReceiptPreview}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  Fechar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
