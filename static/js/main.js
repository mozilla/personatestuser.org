_.templateSettings = {
  interpolate: /\{\{(.+?)\}\}/g
};

var UserEmail = Backbone.Model.extend({
  defaults: {
    email: '',
    password: '',
    expiresDisplay: 'Kinda soon'
  }
});

var Assertion = Backbone.Model.extend({
  defaults: {
    assertion: ''
  }
});

var Application = Backbone.Model.extend({});

var UserEmailView = Backbone.View.extend({
  model: UserEmail, 

  el: $('#create-user-info'),

  template: _.template( $('#email-template').html() ),

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
  },

  render: function() {
    $(this.el).html(this.template(this.model.toJSON()));
    $(this.el).fadeIn();
    return this;
  },
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
    'click #submit-create-user': 'createUser',
    'click #submit-create-assertion': 'createAssertion'
  },

  initialize: function() {
    var self = this;
    this.userEmailView = new UserEmailView({model: new UserEmail()});
    this.assertionView = new AssertionView({model: new Assertion()});

    var socket = io.connect();
    socket.on('connect', function() {});
    socket.on('message', function(data) {
      if (data.user) {
        self.userEmailView.refresh(data.user);
      } else if (data.assertion) {
        self.assertionView.refresh(data.assertion);
      }
    });

    this.socket = socket;
    _.bindAll(this, 'render');

    return this;
  },

  render: function() {
    return this
  },

  createUser: function(evt) {
    this.userEmailView.refresh();
    this.socket.json.send({method: 'getTestUser'});
    return false;
  },

  createAssertion: function(evt) {
    this.assertionView.refresh();
    this.socket.json.send({method: 'getAssertion'});
    return false;
  }
});


