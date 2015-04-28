import _ = require('underscore');
import AppErrorHandler = require('./lib/app-error-handler');
import BufferView = require('./buffer-view');
import Channel = require('./lib/channel');
import configuration = require('./lib/configuration');
import InputBox = require('./input-box');
import ipc = require('./lib/ipc');
import Name = require('./lib/name');
import NameView = require('./name-view');
import React = require('react');
import shortcut = require('./lib/shortcut-manager');
import TabNav = require('./tab-nav');
import TopicView = require('./topic-view');
import TypedReact = require('typed-react');

const D = React.DOM;

const rootChannelName = configuration.get('root-channel-name');
const commandSymbol = configuration.get('command-symbol');

interface IrcViewProps {
  errorHandler: AppErrorHandler;
  server: string;
}

interface IrcViewState {
  nick: string;
  channels: Channel[];
}

class IrcView extends TypedReact.Component<IrcViewProps, IrcViewState> {
  getInitialState(): IrcViewState {
    return {
      nick: '',
      channels: [new Channel(rootChannelName, true)],
    };
  }

  setNick(nick: string) {
    this.setState(<IrcViewState>{nick});
  }

  componentDidMount() {
    // irc events
    ipc.on('registered', data => this.setNick(data.nick));
    ipc.on('message', this.onMessage);
    ipc.on('join', this.onJoin);
    ipc.on('part', this.onPart);
    ipc.on('nick', this.onChangeNick);
    ipc.on('names', this.onNames);
    ipc.on('+mode', this.onMode.bind(this, true));
    ipc.on('-mode', this.onMode.bind(this, false));
    ipc.on('quit', this.onQuit);
    ipc.on('whois', this.onWhois);
    ipc.on('kick', this.onKick);
    ipc.on('topic', this.onTopic);

    // shortcuts
    shortcut.Manager.on('next-tab', () => {
      let next = Channel.next(this.state.channels);
      this.state.channels = Channel.setCurrent(this.state.channels, next.name);
      this.forceUpdate();
    });
    shortcut.Manager.on('previous-tab', () => {
      let prev = Channel.previous(this.state.channels);
      this.state.channels = Channel.setCurrent(this.state.channels, prev.name);
      this.forceUpdate();
    });

    this.props.errorHandler.on('irc', this.onError);
  }

  setWindowTitle(title: string) {
    let titleTag = document.getElementsByTagName('title')[0];
    titleTag.innerText = title;
  }

  render() {
    this.setWindowTitle(this.props.server);

    let channel = Channel.current(this.state.channels);
    let names = channel.names;
    let topic = channel.topic;

    let className = topic ? 'with-topic' : '';

    return (
      D.div({id: 'irc-view', className},
        TabNav({channels: this.state.channels}),
        TopicView({topic}),
        NameView({names}),
        BufferView({channels: this.state.channels}),
        InputBox({channel: Channel.current(this.state.channels).name,
                  names,
                  submit: this.submitInput})
      )
    );
  }

  submitInput(raw: string) {
    let current = Channel.current(this.state.channels);
    if (raw.startsWith(commandSymbol)) {
      raw = raw.substring(1);
      let methodName = this.tryGetLocalHandler(raw);
      if (methodName) {
        this[methodName](raw);
      } else {
        ipc.send('command', {raw, context: {target: current.name}});
      }
    } else {
      if (current.name !== rootChannelName) {
        ipc.send('message', {raw, context: {target: current.name}});
        current.send(this.state.nick, raw);
        this.forceUpdate();
      }
    }
  }

  tryGetLocalHandler(raw: string): string {
    let tokens = raw.split(' ');
    if (tokens.length === 1 && tokens[0] === 'part' &&
        !Channel.current(this.state.channels).name.startsWith('#')) {
      return 'partPersonalChat';
    } else if (tokens[0] === 'pm') {
      return 'startPersonalChat';
    } else if (tokens.length === 1 && tokens[0] === 'topic') {
      return 'showTopic';
    }
  }

  onMessage(data) {
    let to = data.to[0] === '#' || data.to === rootChannelName ? data.to : data.nick;
    Channel.get(this.state.channels, to).send(data.nick, data.text);
    this.forceUpdate();
  }

  onJoin(data) {
    let isMe = data.nick === this.state.nick;
    let channel;
    if (isMe) {
      this.state.channels.push(new Channel(data.channel));
      this.state.channels = Channel.setCurrent(this.state.channels, data.channel);
      channel = Channel.get(this.state.channels, data.channel);
    } else {
      channel = Channel.get(this.state.channels, data.channel);
      channel.addName(data.nick);
    }
    channel.join(data.nick, data.message);
    this.forceUpdate();
  }

  onPart(data) {
    let isMe = data.nick === this.state.nick;
    if (isMe && data.channel !== rootChannelName) {
      this.state.channels = Channel.remove(this.state.channels, data.channel);
      this.state.channels = Channel.setCurrent(this.state.channels, rootChannelName);
    } else {
      let channel = Channel.get(this.state.channels, data.channel);
      channel.part(data.nick, data.reason, data.message);
      channel.removeName(data.nick);
    }
    this.forceUpdate();
  }

  startPersonalChat(raw: string) {
    let tokens = raw.split(' ');
    if (tokens.length < 3) {
      this.props.errorHandler.handle({
        type: 'normal',
        error: new Error('Invalid command arguments: [nick,message]'),
      });
    } else {
      let target = tokens[1];
      let raw = tokens.splice(2).join(' ');
      ipc.send('message', {raw, context: {target}});
      let channel = Channel.get(this.state.channels, target);
      channel.send(this.state.nick, raw);
      this.state.channels = Channel.setCurrent(this.state.channels, target);
      this.forceUpdate();
    }
  }

  showTopic() {
    let channel = Channel.current(this.state.channels);
    channel.showTopic();
    this.forceUpdate();
  }

  partPersonalChat() {
    let current = Channel.current(this.state.channels);
    this.state.channels = Channel.remove(this.state.channels, current.name);
    this.state.channels = Channel.setCurrent(this.state.channels, rootChannelName);
    this.forceUpdate();
  }

  onChangeNick(data) {
    let channel = Channel.get(this.state.channels, data.channel);
    if (data.oldnick === this.state.nick) {
      this.setState(<IrcViewState>{nick: data.newnick});
      data.channels.push(rootChannelName);
    }
    data.channels.forEach((channel) => {
      channel.updateName(data.oldnick, data.newnick);
    });
    this.forceUpdate();
  }

  onNames(data) {
    let channel = Channel.get(this.state.channels, data.channel);
    let names = Object.keys(data.names).map<Name>((nick: string) => {
      return new Name(nick, data.names[nick], nick === this.state.nick);
    });
    channel.setNames(names);
    this.forceUpdate();
  }

  onMode(isGiving: boolean, data) {
    let channel = Channel.get(this.state.channels, data.channel);
    if (isGiving) {
      channel.giveMode(data.mode, data.by, data.target);
    } else {
      channel.takeMode(data.mode, data.by, data.target);
    }
    this.forceUpdate();
  }

  onQuit(data) {
    data.channels.forEach((channel) => {
      let dataForChannel = _.extend(_.omit(data, 'channels'), {channel});
      this.onPart(dataForChannel);
    });
  }

  onWhois(data) {
    let info = data.info;
    let root = Channel.get(this.state.channels, rootChannelName);
    let current = Channel.current(this.state.channels);
    root.whois(info);
    current.whois(info);
    this.forceUpdate();
  }

  onKick(data) {
    let isMe = data.nick === this.state.nick;
    let channel = Channel.get(this.state.channels, data.channel);
    if (isMe) {
      let root = Channel.get(this.state.channels, rootChannelName);
      root.kick(data.channel, data.nick, data.by, data.reason);
      this.state.channels = Channel.remove(this.state.channels, channel.name);
      this.state.channels = Channel.setCurrent(this.state.channels, rootChannelName);
    } else {
      channel.kick(data.channel, data.nick, data.by, data.reason);
      channel.removeName(data.nick);
    }
    this.forceUpdate();
  }

  onTopic(data) {
    let channel = Channel.get(this.state.channels, data.channel);
    channel.setTopic(data.topic, data.nick);
    this.forceUpdate();
  }

  onError(error) {
    switch (error.command) {
    case "err_nosuchnick":
      let channel = Channel.get(this.state.channels, error.args[1]);
      channel.send(error.args[1], error.args[2]);
      this.forceUpdate();
      break;
    }
  }
}

export = React.createFactory(TypedReact.createClass(IrcView));