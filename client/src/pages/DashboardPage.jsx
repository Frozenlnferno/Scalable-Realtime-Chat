import { useEffect, useRef, useState } from 'react';
import { createMessage, getMessages, getUsers, openDirectConversation } from '../services/apiService';
import { logout } from '../services/authService';
import { connectChatSocket } from '../services/socketService';

function addMessage(messages, message) {
  return messages.some((item) => item.id === message.id) ? messages : [...messages, message];
}

export default function DashboardPage({ session, onSignedOut }) {
  const [users, setUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const activeConversationId = useRef(null);

  useEffect(() => { activeConversationId.current = conversation?.id || null; }, [conversation]);

  useEffect(() => {
    getUsers().then(({ currentUser, users: directory }) => {
      setCurrentUserId(currentUser.id);
      setUsers(directory);
    }).catch((requestError) => setError(requestError.message)).finally(() => setLoadingUsers(false));
    let socket;
    connectChatSocket((message) => {
      if (message.conversationId === activeConversationId.current) setMessages((current) => addMessage(current, message));
    }).then((connectedSocket) => { socket = connectedSocket; }).catch((connectionError) => setError(connectionError.message));
    return () => socket?.disconnect();
  }, []);

  async function selectUser(user) {
    setError('');
    try {
      const { conversation: openedConversation } = await openDirectConversation(user.id);
      const { messages: history } = await getMessages(openedConversation.id);
      setConversation({ ...openedConversation, participant: user });
      setMessages(history);
    } catch (requestError) { setError(requestError.message); }
  }

  async function send(event) {
    event.preventDefault();
    if (!conversation || !draft.trim()) return;
    const body = draft;
    setDraft('');
    try {
      const { message } = await createMessage(conversation.id, body);
      setMessages((current) => addMessage(current, message));
    } catch (requestError) {
      setDraft(body);
      setError(requestError.message);
    }
  }

  async function signOut() {
    await logout();
    onSignedOut();
  }

  return (
    <main className="chat-shell">
      <aside className="directory-panel">
        <div className="panel-header"><div><p className="eyebrow">SIGNED IN AS</p><strong>{session.email}</strong></div><button className="secondary-button" onClick={signOut}>Sign out</button></div>
        <h1>People</h1>
        {loadingUsers ? <p className="muted">Loading people…</p> : users.length ? <div className="user-list">{users.map((user) => <button key={user.id} className={`user-row ${conversation?.participant?.id === user.id ? 'selected' : ''}`} onClick={() => selectUser(user)}>{user.email}</button>)}</div> : <p className="muted">No one else has signed in yet.</p>}
      </aside>
      <section className="conversation-panel">
        {conversation ? <>
          <header className="conversation-header"><p className="eyebrow">DIRECT MESSAGE</p><h2>{conversation.participant.email}</h2></header>
          <div className="message-list">{messages.length ? messages.map((message) => <div key={message.id} className={`chat-message ${message.senderId === currentUserId ? 'mine' : ''}`}><p>{message.body}</p><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>) : <p className="muted">Say hello.</p>}</div>
          <form className="composer" onSubmit={send}><input value={draft} maxLength="4000" onChange={(event) => setDraft(event.target.value)} placeholder="Write a message…" /><button type="submit">Send</button></form>
        </> : <div className="empty-conversation"><h1>Choose someone to chat with</h1><p>Start a direct conversation from the people list.</p></div>}
        {error && <p className="dashboard-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
