const AUTOMATION_TEMPLATES = [

  // ─── CORE (shown by default) ───────────────────────────────────────────────

  {
    id: 'new_lead_followup',
    name: 'Follow up on every new lead',
    description: 'Creates a follow-up task the moment a new contact is added — so no lead ever falls through the cracks',
    category: 'core',
    icon: '🎯',
    trigger: { type: 'contact.created', config: {} },
    conditions: [],
    actions: [
      {
        type: 'create_task',
        config: {
          taskTitle: 'Follow up with {{contact.firstName}} {{contact.lastName}}',
          taskType: 'follow_up',
          taskPriority: 'high',
          taskDueDays: 0,
          assignTo: 'same_as_contact',
        },
      },
    ],
  },

  {
    id: 'follow_up_cold_deal',
    name: 'Follow up when a deal goes cold',
    description: 'Creates a task, emails the deal owner, and sends a WhatsApp ping when a deal has had no activity for 3 days',
    category: 'core',
    icon: '🥶',
    trigger: { type: 'deal.inactive', config: { inactiveDays: 3 } },
    conditions: [],
    actions: [
      {
        type: 'create_task',
        config: {
          taskTitle: 'Re-engage: {{deal.title}} has gone cold',
          taskType: 'follow_up',
          taskPriority: 'high',
          taskDueDays: 0,
          assignTo: 'same_as_deal',
        },
      },
      {
        type: 'send_email',
        config: {
          to: 'assigned_user',
          subject: 'Deal going cold: {{deal.title}}',
          body: '<p>Hi,</p><p>Your deal <strong>{{deal.title}}</strong> with {{contact.firstName}} {{contact.lastName}} has had no activity for 3 days. It may need your attention.</p><p>Log in to take action before you lose the opportunity.</p>',
        },
      },
      {
        type: 'send_whatsapp',
        config: {
          whatsappTemplate: 'deal_inactive',
          whatsappTo: 'assigned_user',
        },
      },
    ],
  },

  {
    id: 'auto_assign_new_lead',
    name: 'Auto-assign new leads to a team member',
    description: 'Automatically assigns every new contact to a specific sales rep',
    category: 'core',
    icon: '👤',
    trigger: { type: 'contact.created', config: {} },
    conditions: [],
    actions: [
      {
        type: 'assign_to_user',
        config: { userId: '' }, // user fills in on activation
      },
    ],
  },

  {
    id: 'new_contact_create_deal',
    name: 'Open a deal when a new contact is added',
    description: 'Automatically creates a deal in your pipeline every time a new contact is added',
    category: 'core',
    icon: '🚀',
    trigger: { type: 'contact.created', config: {} },
    conditions: [],
    actions: [
      {
        type: 'create_deal',
        config: {
          dealTitle: 'New opportunity — {{contact.firstName}} {{contact.lastName}}',
          assignTo: 'same_as_contact',
          pipelineId: '',
          stageId: '',
        },
      },
    ],
  },

  // ─── DEALS ────────────────────────────────────────────────────────────────

  {
    id: 'no_response_followup',
    name: 'Follow up when a deal gets no response',
    description: 'Creates a follow-up task when a deal has been in the "Contacted" stage for more than 1 day with no movement',
    category: 'deals',
    icon: '📵',
    trigger: { type: 'deal.inactive', config: { inactiveDays: 1 } },
    conditions: [
      { field: 'deal.stageName', operator: 'contains', value: 'Contact' },
    ],
    actions: [
      {
        type: 'create_task',
        config: {
          taskTitle: 'No response — follow up with {{contact.firstName}}',
          taskType: 'call',
          taskPriority: 'high',
          taskDueDays: 0,
          assignTo: 'same_as_deal',
        },
      },
    ],
  },

  {
    id: 'hot_lead_tagging',
    name: 'Tag deal as hot when it reaches negotiation',
    description: 'Automatically adds a "hot" tag to the contact when their deal reaches the negotiation stage',
    category: 'deals',
    icon: '🔥',
    trigger: { type: 'deal.stage_changed', config: {} },
    conditions: [
      { field: 'deal.stageName', operator: 'contains', value: 'Negotiat' },
    ],
    actions: [
      { type: 'add_tag', config: { tag: 'hot' } },
    ],
  },

  {
    id: 'proposal_task',
    name: 'Create a task when a deal changes stage',
    description: 'Creates an action task whenever a deal moves to a specific stage — configure which stage on activation',
    category: 'deals',
    icon: '📋',
    trigger: { type: 'deal.stage_changed', config: {} },
    conditions: [],
    actions: [
      {
        type: 'create_task',
        config: {
          taskTitle: 'Action required: {{deal.title}}',
          taskType: 'follow_up',
          taskPriority: 'medium',
          taskDueDays: 2,
          assignTo: 'same_as_deal',
        },
      },
    ],
  },

  {
    id: 'deal_won_tag',
    name: 'Tag contact when deal is won',
    description: 'Adds a "customer" tag and sends the deal owner a congratulations email when a deal is marked as won',
    category: 'deals',
    icon: '🎉',
    trigger: { type: 'deal.won', config: {} },
    conditions: [],
    actions: [
      { type: 'add_tag', config: { tag: 'customer' } },
      {
        type: 'send_email',
        config: {
          to: 'assigned_user',
          subject: '🎉 You closed it — {{deal.title}}',
          body: '<p>Congratulations! You just closed <strong>{{deal.title}}</strong> with {{contact.firstName}} {{contact.lastName}}. Great work!</p>',
        },
      },
    ],
  },

  {
    id: 'deal_lost_followup',
    name: 'Re-engage a lost deal in 30 days',
    description: 'Tags the contact as a lost opportunity and creates a 30-day follow-up task to re-engage them later',
    category: 'deals',
    icon: '📉',
    trigger: { type: 'deal.lost', config: {} },
    conditions: [],
    actions: [
      { type: 'add_tag', config: { tag: 'lost-deal' } },
      {
        type: 'create_task',
        config: {
          taskTitle: 'Re-engage {{contact.firstName}} {{contact.lastName}} — lost deal follow-up',
          taskType: 'follow_up',
          taskPriority: 'low',
          taskDueDays: 30,
          assignTo: 'same_as_deal',
        },
      },
    ],
  },

  // ─── TASKS ────────────────────────────────────────────────────────────────

  {
    id: 'overdue_task_email',
    name: 'Remind rep about overdue tasks',
    description: 'Sends an email to the assigned rep when one of their tasks becomes overdue',
    category: 'tasks',
    icon: '⏰',
    trigger: { type: 'task.overdue', config: {} },
    conditions: [],
    actions: [
      {
        type: 'send_email',
        config: {
          to: 'assigned_user',
          subject: 'Overdue: {{task.title}}',
          body: '<p>Hi,</p><p>You have an overdue task: <strong>{{task.title}}</strong>. Please action this as soon as possible.</p>',
        },
      },
    ],
  },

  // ─── ADVANCED / DEVELOPERS ────────────────────────────────────────────────

  {
    id: 'n8n_new_contact_webhook',
    name: 'Send new contact to n8n',
    description: 'Fires a webhook to your n8n workflow every time a new contact is added — connect to any app',
    category: 'advanced',
    icon: '🔗',
    trigger: { type: 'contact.created', config: {} },
    conditions: [],
    actions: [
      { type: 'send_webhook', config: { url: '', method: 'POST', payload: 'full_context' } },
    ],
  },
  {
    id: 'n8n_deal_won_webhook',
    name: 'Send won deal to n8n',
    description: 'Fires a webhook to n8n when a deal is won — post to Slack, Google Sheets, WhatsApp etc.',
    category: 'advanced',
    icon: '🔗',
    trigger: { type: 'deal.won', config: {} },
    conditions: [],
    actions: [
      { type: 'send_webhook', config: { url: '', method: 'POST', payload: 'full_context' } },
    ],
  },
  {
    id: 'n8n_deal_stage_webhook',
    name: 'Notify n8n on deal stage change',
    description: 'Fires a webhook every time a deal moves to a new stage',
    category: 'advanced',
    icon: '🔗',
    trigger: { type: 'deal.stage_changed', config: {} },
    conditions: [],
    actions: [
      { type: 'send_webhook', config: { url: '', method: 'POST', payload: 'full_context' } },
    ],
  },
];

module.exports = AUTOMATION_TEMPLATES;