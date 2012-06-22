_.templateSettings = {
  interpolate: /\{\{(.+?)\}\}/g
};

var UserEmail = Backbone.Model.extend({
  defaults: {
    email: '',
    password: '',
    token: '',
    expiresDisplay: 'Kinda soon'
  }
});

var Assertion = Backbone.Model.extend({
  defaults: {
    assertion: ''
  }
});

var Application = Backbone.Model.extend({});

var VerifiedEmailView = Backbone.View.extend({
  model: UserEmail,

  el: $('#create-verified-email-info'),

  template: _.template( $('#verified-email-template').html() ),

  initialize: function() {
    _.bindAll(this, 'render');
    this.refresh();
  },

  render: function() {
    $(this.el).html(this.template(this.model.toJSON()));
    $(this.el).fadeIn();

    return this;
  },

  refresh: function(data) {
    if (data && (data.email && data.password)) {
      data.expiresDisplay = (new Date(data.expires)).toLocaleString();
      this.model.set(data);
      this.render();
    } else {
      $(this.el).hide();
    }
  }
});

var UnverifiedEmailView = Backbone.View.extend({
  model: UserEmail,

  el: $('#create-unverified-email-info'),

  template: _.template( $('#unverified-email-template').html() ),

  initialize: function() {
    _.bindAll(this, 'render');
    this.refresh();
  },

  render: function() {
    $(this.el).html(this.template(this.model.toJSON()));
    $(this.el).fadeIn();

    return this;
  },

  refresh: function(data) {
    if (data && (data.email && data.password)) {
      data.expiresDisplay = (new Date(data.expires)).toLocaleString();
      this.model.set(data);
      this.render();
    } else {
      $(this.el).hide();
    }
  }
});

var AssertionView = Backbone.View.extend({
  model: Assertion,

  el: $('#create-assertion-info'),

  refresh: function(data) {
  },

  render: function() {
    return this;
  },

});

var ApplicationView = Backbone.View.extend({
  model: Application,

  // If you don't specify an element, event delegation won't work
  el: $("#content"),

  events: {
    'click #submit-email-verified': 'createVerifiedEmail',
    'click #submit-emial-unverified': 'createUnverifiedEmail',
    'click #submit-create-assertion': 'createAssertion'
  },

  initialize: function() {
    var self = this;
    this.verifiedEmailView = new VerifiedEmailView({model: new UserEmail()});
    this.unverifiedEmailView = new UnverifiedEmailView({model: new UserEmail()});
    this.assertionView = new AssertionView({model: new Assertion()});

    var socket = io.connect();
    socket.on('connect', function() {});
    socket.on('message', function(data) {
      switch (data.type) {
        case "status":
          $('#status .message')
            .hide()
            .text(data.data)
            .fadeIn(150);
         break;
        case "verifiedEmail":
          self.verifiedEmailView.refresh(data.data);
          break;
        case "unverifiedEmail":
          self.unverifiedEmailView.refresh(data.data);
          break;
        default:
          break;
      }
    });

    this.socket = socket;
    _.bindAll(this, 'render');

    return this;
  },

  render: function() {
    return this;
  },

  createVerifiedEmail: function(evt) {
    // XXX when the user clicks this button, it should
    // be disabled until the completion process terminates.
    this.verifiedEmailView.refresh();
    this.socket.json.send({method: 'getVerifiedEmail'});
    return false;
  },

  createUnverifiedEmail: function(evt) {
    this.unverifiedEmailView.refresh();
    this.socket.json.send({method: 'getUnverifiedEmail'});
    return false;
  },

  createAssertion: function(evt) {
    this.assertionView.refresh();
    this.socket.json.send({method: 'getAssertion'});
    return false;
  }
});
